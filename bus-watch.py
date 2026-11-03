#!/usr/bin/env python3
"""Event-driven cross-claude bus watcher (python3 twin of bus-watch.mjs).

Polls the bus REST API and prints ONE stdout line per NEW message not sent by this
instance. Between messages it polls quietly, so a session is woken only when a real
message arrives. Use this on machines without Node; bus-watch.mjs is the Node twin.
Keep the two implementations behaviorally identical.

How it runs:
  --exit-on-message  as a background command that ENDS on the first poll round that
                     found messages, after printing every one of them. The session
                     wakes once per batch on the command's completion, never on a
                     timer, and re-arms with --resume.
  (neither flag)     as an endless stream, one event per line, for a host that keeps
                     a streaming watch alive.
  --resume           start from the read position the last run of this instance id
                     saved, with the channels that woke it, so nothing that arrived
                     between two runs is missed, in any channel. Without it the
                     watcher starts from the newest message. Pass it on a RE-arm only:
                     on a session's first arm, a position saved under the same id by
                     an earlier session would replay its messages.
  --once             a single poll round, then exit 0 (a connectivity test).

Exit codes: 0 after printing messages under --exit-on-message, after --once, or when
stopped by a signal, so a 0 with no message line means something outside stopped it.
1 means it stopped itself over a fault, after printing one line that says so and
writing the reason to its log. 2 means --instance was missing.

Configuration -- all env vars are optional on a machine that has the cross-claude
MCP server configured, because the bus URL and token are read from that config.
The instance id is the exception: it is REQUIRED on argv, see below.
  CROSS_CLAUDE_URL      bus base URL (overrides the configured one)
  CROSS_CLAUDE_TOKEN    bearer token -- prefer a config file, since env on a
                        command line is visible in the process list
  CROSS_CLAUDE_CFG      config file, in either shape: a Claude client config (the
                        cross-claude MCP entry carries both url and auth header)
                        or an env file with BUS_URL= / MCP_API_KEY=. Read before,
                        and in addition to, ~/.claude.json
  CROSS_CLAUDE_POLL_MS  poll interval
  CROSS_CLAUDE_FILTER   "participant" (default) or "all" -- see below

Channels are discovered DYNAMICALLY from GET /api/channels every poll round --
a hardcoded channel list silently hears nothing when the work moves to a new
channel. Channels existing at startup are baselined at their current last_id
(no history replay); channels that appear mid-run start from 0 so their very
first messages are not missed; transient discovery failures keep the last
known set.

Only MESSAGES wake a session. A channel's pinned text is metadata on the channel
record: the channel listing carries has_pin and never the text, and a message poll
never carries it either, so pinning or replacing a text emits nothing here. A
session that wants that text reads it deliberately.

Only messages reach stdout. Everything else goes to stderr: a poll the bus did not
answer is noted once per channel, and once more when that channel answers again. A
failure that stops this watcher doing its one job ends the process with a line saying
what failed, because a watcher that cannot emit must never look like a quiet bus.

Channel FILTER (multi-machine buses): with more than two instances on the bus,
watching every channel wakes an instance for conversations between OTHER peers.
CROSS_CLAUDE_FILTER=participant (default) EMITS only for #general (the
rendezvous channel) plus channels this INSTANCE participates in. The REST
/api/channels payload carries no participants field, so participation is
determined client-side: at classification time the channel's history is scanned
for a message sent by INSTANCE; non-participant channels are still POLLED (same
API cost) but silently -- their deltas are scanned for INSTANCE's own sender id,
and the first own message GRADUATES the channel to emitting (messages after it
in the same delta are emitted too, so a peer reply that lands in the same poll
round is not lost). The rendezvous convention makes this safe: first contact /
channel switches are announced in #general, and your reply in a channel is
exactly what makes it wake you afterwards. Set CROSS_CLAUDE_FILTER=all for the
old watch-everything behavior.

Two argv lists override that classification per session:
  --mute <a,b>    never emit for these channels, whatever the filter says.
                  #general is the one the filter cannot drop on its own, and a
                  session whose work has moved to its own channel does not want
                  waking by unrelated announcements there.
  --always <a,b>  always emit for these, skipping the participant verdict. The
                  verdict reads history, and history expires with the server's
                  retention, so a channel the session must never miss is named
                  here rather than left to evidence that ages out.
Mute wins over always. Both are still POLLED, like any other channel.

Usage:
  python3 bus-watch.py --instance <prefix>.<suffix> --once   # baseline + one poll, armed line on stderr, exit 0 (connectivity test)
  python3 bus-watch.py --instance <prefix>.<suffix> --exit-on-message [--resume]   # ends on the first messages
  python3 bus-watch.py --instance <prefix>.<suffix>          # endless poll loop, one event per line
"""
import json, os, time, sys, re, signal, traceback, http.client, urllib.request
from datetime import datetime, timezone
from urllib.parse import quote as enc  # channel names and ids are URL components

# Printing one line IS the job, so the print must never be the thing that fails. A python
# stdout that is a pipe or a file takes the platform's code page, and on Windows that code
# page cannot encode the bell character an emitted line opens with. Both streams are set to
# UTF-8 here, before anything is written, and a character a reader still cannot take degrades
# to an escape rather than costing the whole line.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="backslashreplace")


class BusUnreachable(Exception):
    """The bus could not be read: the request failed, or its answer was not JSON."""

POLL_S   = (int(os.environ.get("CROSS_CLAUDE_POLL_MS") or 0) / 1000) or 20
FILTER   = (os.environ.get("CROSS_CLAUDE_FILTER") or "participant").strip().lower()
# The id belongs to the SESSION that arms this watcher, not to the machine, so it MUST
# arrive on argv: a launcher or an env var cannot carry a value that differs per session.
# There is deliberately NO fallback. Every implicit source yields a WRONG id rather than a
# missing one -- an env var holds a machine-wide name, and the hostname is either the bare
# machine prefix (an id the protocol forbids) or a name no session ever registered, e.g. an
# mDNS `*.local`. Both look plausible, and the failure is silent in the worst direction: an
# unregistered id matches nothing in the self-filter, so the watcher wakes you for your OWN
# messages, while the participant filter finds no channel that id has posted in, so it stays
# quiet for the peer you are waiting on. That is indistinguishable from a quiet bus.
# Assert the value was passed rather than checking its shape: a shape check cannot tell a
# deliberate id from a hostname that happens to look like one. The sys.argv[:-1] slice is
# what makes a trailing "--instance" with no value fail here instead of falling through.
ARG_INSTANCE = sys.argv[sys.argv.index("--instance") + 1] if "--instance" in sys.argv[:-1] else ""
INSTANCE = ARG_INSTANCE.strip().lower()
if not INSTANCE or INSTANCE.startswith("--"):
    sys.stderr.write("bus-watch: --instance <prefix>.<suffix> is required (the id belongs to this session, not the machine).\n")
    sys.exit(2)
MAXLEN   = 600
ONCE     = "--once" in sys.argv
EXIT_ON_MESSAGE = "--exit-on-message" in sys.argv
RESUME   = "--resume" in sys.argv

# --- Failure reporting, the same contract as the node twin. This watcher IS an unattended
# session's liveness mechanism, so its own death must never be silent: a watcher that is gone looks
# exactly like a quiet bus. Every diagnostic goes to a FILE beside this script as well as to
# stderr, because the harness's pipes are themselves a suspect whenever a watcher dies with no
# trace, and a stack written to a broken pipe is lost exactly when it is needed. Every write out of
# this process is guarded, so reporting a failure can never be the thing that ends the watch. And a
# fault the watcher cannot classify as a transient bus STOPS it, with the reason in the log first:
# the same rule the unemittable-line path follows, because a watcher carrying an unknown fault must
# not keep polling as though it were healthy. Stopping is visible (the harness reports the task
# ended) and silence is not, which is the whole distinction this file is built around.
#
# Reading the log after a death: a line naming a signal means something stopped the watcher on
# purpose. A crash line means the watcher's own code failed and the traceback says where. A log
# that simply STOPS, with neither kind of line, means the process was terminated without warning
# (a hard kill, which no handler can catch), so look at what was managing it rather than here.
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", f"bus-watch-{INSTANCE}.log")


def note(line):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(f"{datetime.now(timezone.utc).isoformat()} [{INSTANCE}] {line}\n")
    except Exception:
        pass  # a log that cannot be written is not allowed to be what kills the watcher
    try:
        sys.stderr.write(f"bus-watch: {line}\n")
        sys.stderr.flush()
    except Exception:
        pass  # broken pipe: the file holds it


# The log line goes first and the event second, because the file is the copy that survives a pipe
# the harness has already taken away. Then the process ends: a fault nobody classified is not
# something to poll through.
def fatal(what, err):
    detail = " ".join(" ".join(traceback.format_exception(type(err), err, err.__traceback__)).split())
    note(f"Stopping, {what}: {detail}")
    try:
        print(f"\U0001f514 cross-claude bus-watch [{INSTANCE}] stopped, {what}. Re-arm it; the reason is in {LOG}", flush=True)
    except Exception:
        pass  # no channel left to say it on
    sys.exit(1)


def _on_signal(signum, _frame):
    note(f"stopped by signal {signum}")
    sys.exit(0)


for _sig in ("SIGTERM", "SIGINT", "SIGBREAK", "SIGHUP"):
    try:
        signal.signal(getattr(signal, _sig), _on_signal)
    except (AttributeError, ValueError, OSError):
        pass  # not every signal exists on every platform

# --- The read position, per channel, that one run hands to the next, together with the channels
# that wake the session, so a resumed run continues exactly as the last one stood: a participant
# verdict re-derived from history would forget a channel whose own post has aged out of it. It is
# written after every round that moved it, so a run stopped from outside still leaves the last
# position it reached. A position that cannot be written, or one that cannot be read back, stops
# the watcher: either would lose messages in silence between two runs.
CURSOR = os.path.join(os.path.dirname(LOG), f"bus-watch-{INSTANCE}.cursor.json")
_saved_text = ""


def save_cursor():
    global _saved_text
    channels = dict(last)
    emitting = sorted(c for c in part if part[c])
    text = json.dumps({"channels": channels, "emitting": emitting}, sort_keys=True)
    if text == _saved_text:
        return
    try:
        os.makedirs(os.path.dirname(CURSOR), exist_ok=True)
        with open(CURSOR + ".tmp", "w", encoding="utf-8") as fh:
            json.dump({"instance": INSTANCE, "saved": datetime.now(timezone.utc).isoformat(),
                       "channels": channels, "emitting": emitting}, fh)
        os.replace(CURSOR + ".tmp", CURSOR)
    except Exception as err:
        fatal(f"the read position could not be saved to {CURSOR}", err)
    _saved_text = text


def load_cursor():
    try:
        with open(CURSOR, "r", encoding="utf-8") as fh:
            text = fh.read()
    except FileNotFoundError:
        note("no saved read position for this id, starting from the newest message")
        return None
    except Exception as err:
        fatal(f"the saved read position in {CURSOR} could not be read", err)
    try:
        data = json.loads(text)
        channels = data.get("channels")
        emitting = data.get("emitting", [])
        if not isinstance(channels, dict):
            raise ValueError("no channels in the file")
        for ch, pos in channels.items():
            if type(pos) is not int or pos < 0:
                raise ValueError(f"channel {ch} has no valid position")
        if not isinstance(emitting, list) or any(not isinstance(c, str) for c in emitting):
            raise ValueError("the waking channels are not a list of names")
        return {"channels": channels, "emitting": set(emitting)}
    except Exception as err:
        fatal(f"the saved read position in {CURSOR} is damaged; delete it to start from the newest message", err)


# A run that does not resume starts from the newest message, and a position it replaces is gone,
# so the replacement is said where the session will look for it.
def warn_unresumed():
    if not RESUME and os.path.exists(CURSOR):
        note("a saved read position exists and is not resumed, so messages since it are skipped; "
             "pass --resume to continue from it")

# Per-session channel choices, on argv for the same reason the instance id is: they belong to what
# THIS session is doing, not to the machine. --mute names channels that never emit however the
# filter classifies them; --always names channels that emit regardless of the participant verdict.
# Mute wins over always: a deliberate silence outranks a deliberate noise.
# --mute exists because the participant filter cannot drop the rendezvous channel, and a session
# whose work has moved to its own channel is woken by every unrelated announcement there.
# --always exists because a participant verdict is evidence-based and the evidence expires: the
# server deletes messages past its retention window, so a channel this instance posted in months
# ago silently stops waking it. Naming it here is the standing answer for a channel the session
# must never miss.
def list_arg(name):
    raw = sys.argv[sys.argv.index(name) + 1] if name in sys.argv[:-1] else ""
    return {s.strip().lower() for s in raw.split(",") if s.strip() and not s.strip().startswith("--")}

MUTED  = list_arg("--mute")
ALWAYS = list_arg("--always")

def read_config(file):
    # Reads either config shape: a Claude client config, whose cross-claude MCP
    # entry carries both the bus URL and the auth header, or an env file with
    # BUS_URL= / MCP_API_KEY=. An unreadable file yields nothing rather than
    # raising -- another source, or the environment, may supply the missing half.
    try:
        with open(file, "r", encoding="utf-8") as fh:
            text = fh.read()
    except Exception:
        return {}
    if text.lstrip().startswith("{"):
        try:
            entry = json.loads(text).get("mcpServers", {}).get("cross-claude", {})
        except Exception:
            return {}
        return {"url": entry.get("url") or "",
                "auth": (entry.get("headers") or {}).get("Authorization") or ""}
    def value(key):
        m = re.search(rf"^{key}=(.*)$", text, re.M | re.I)
        return m.group(1).strip() if m else ""
    return {"url": value("BUS_URL"), "auth": value("MCP_API_KEY")}

CONFIGS = [f for f in (os.environ.get("CROSS_CLAUDE_CFG"), os.path.expanduser("~/.claude.json")) if f]
cfg = {"url": "", "auth": ""}
for found in (read_config(f) for f in CONFIGS):
    cfg = {"url": cfg["url"] or found.get("url", ""), "auth": cfg["auth"] or found.get("auth", "")}

# The configured MCP endpoint ends in /mcp; the REST API this polls sits next to it.
BASE = re.sub(r"/mcp/*$", "", (os.environ.get("CROSS_CLAUDE_URL") or cfg["url"] or "").strip().rstrip("/"), flags=re.I)
AUTH = (os.environ.get("CROSS_CLAUDE_TOKEN") or cfg["auth"] or "").strip()
if not BASE or not AUTH:
    missing = " and ".join([m for m in ("bus URL" if not BASE else "", "token" if not AUTH else "") if m])
    raise SystemExit(f"cross-claude {missing} not found: configure the cross-claude MCP server on this "
                     "machine, or set CROSS_CLAUDE_URL / CROSS_CLAUDE_TOKEN / CROSS_CLAUDE_CFG "
                     f"(looked in {', '.join(CONFIGS)})")

HEADERS = {"Authorization": AUTH if AUTH.startswith("Bearer ") else "Bearer " + AUTH}

# Every way the bus can fail to answer is raised as one type, so a caller can tell a bus that
# is briefly away from a fault in the watcher itself. Everything this function can raise is a
# transport or a parse failure, which is what makes the whole body one boundary.
def get_json(url):
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    except (OSError, ValueError, http.client.HTTPException) as err:
        raise BusUnreachable(f"{type(err).__name__}: {err}") from err

last = {}        # channel -> last seen message id
started = False  # has the channel list been read once?
emitted = 0      # message lines printed in the current round
resumed = load_cursor() if RESUME else None  # {"channels": position per channel, "emitting": set}

part = {}  # channel -> True (emit) / False (silent scan); absent = unclassified, retry
away = set()  # channels whose last poll the bus did not answer, so the note is printed once
unbaselined = set()  # channels whose newest message could not be read yet

def list_channels():
    j = get_json(f"{BASE}/api/channels")
    return [c.get("name") for c in (j.get("channels") or []) if c.get("name")]

# The bus orders a channel's messages by time, and two posted within one tick of its clock come
# back in either order, so its own last_id can name a message older than one it just returned.
# The read position is therefore the highest id actually received, and messages print in id order.
def by_id(j):
    return sorted(j.get("messages") or [], key=lambda m: m.get("id") or 0)

def newest(ms, floor):
    return max([floor] + [m.get("id") or 0 for m in ms])

def head_of(ch):
    # A window rather than one message, since the newest by time may not be the newest by id.
    # None when the bus did not answer: a channel is never baselined at 0 by accident, which would
    # replay its whole history.
    try:
        return newest(by_id(get_json(f"{BASE}/api/messages/{enc(ch)}?limit=50")), 0)
    except BusUnreachable:
        return None

def classify(ch):
    # -> True/False participant verdict, or None on transient error (retry next round).
    # The two explicit lists are decided first and never hit the network: they are the session's
    # own instruction, not something to be re-derived from the channel's history each round.
    if ch in MUTED:
        return False
    if ch in ALWAYS:
        return True
    if FILTER != "participant" or ch == "general":
        return True
    if resumed is not None and ch in resumed["emitting"]:
        return True
    try:
        j = get_json(f"{BASE}/api/messages/{enc(ch)}?limit=500")
        return any(m.get("sender") == INSTANCE for m in (j.get("messages") or []))
    except BusUnreachable:
        return None

def sync_channels():
    # Discover channels each round; tolerate transient failures (keep last known set).
    global started
    try:
        names = list_channels()
    except BusUnreachable:
        return list(last.keys())
    for ch in names:
        if ch not in last:
            if resumed is not None and ch in resumed["channels"]:
                last[ch] = resumed["channels"][ch]  # resume: continue exactly where the last run stopped
            elif (not started and resumed is None) or ch in unbaselined:
                # startup: baseline at head, no history replay. A channel whose head could not be read
                # stays out of the watch until it can, rather than starting from its beginning.
                head = head_of(ch)
                if head is None:
                    unbaselined.add(ch)
                    continue
                unbaselined.discard(ch)
                last[ch] = head
            else:
                # Appeared mid-run, or since the saved position: brand new, deliver from the beginning.
                last[ch] = 0
                note(f"new channel discovered: {ch}")
        if ch not in part:
            verdict = classify(ch)
            if verdict is not None:
                part[ch] = verdict
    # Only a list the bus answered ends startup, so a channel missing from a failed first read is
    # still baselined at head later rather than replayed from its beginning.
    started = True
    return list(last.keys())

def emit(ch, m):
    global emitted
    c = re.sub(r"\s+", " ", str(m.get("content", ""))).strip()[:MAXLEN]
    line = (f"\U0001f514 cross-claude [{ch} #{m.get('id')} {m.get('message_type')}] "
            f"{m.get('sender')}: {c}")
    try:
        print(line, flush=True)
    except Exception as err:
        # A watcher that cannot print its line wakes nobody, and from outside that reads
        # exactly like an idle bus. So it stops and says why, rather than polling on.
        note(f"Stopped, a message line could not be printed. {type(err).__name__}: {err}")
        raise SystemExit(1)
    emitted += 1

def poll(ch):
    # An unclassified channel is not polled: a silent scan would move its position past messages
    # that a participant verdict, once the bus answers, should have printed.
    if ch not in part:
        return
    try:
        if part.get(ch):
            # participating channel: emit every new peer message (server drops our own)
            ms = by_id(get_json(f"{BASE}/api/messages/{enc(ch)}?after_id={last[ch]}&instance_id={enc(INSTANCE)}"))
            for m in ms:
                emit(ch, m)
            last[ch] = newest(ms, last[ch])
        else:
            # silent scan: same poll WITHOUT instance_id so our own sends are visible;
            # our first own message graduates the channel (and emits peers' messages after it)
            ms = by_id(get_json(f"{BASE}/api/messages/{enc(ch)}?after_id={last[ch]}"))
            mine = [m.get("id") or 0 for m in ms if m.get("sender") == INSTANCE]
            # Graduation never lifts a mute. Mute is the session's own instruction and it outranks
            # every verdict including this one, because the ordinary way a session touches a muted
            # channel is to POST in it, such as a status in the rendezvous channel it does not want
            # waking on.
            if mine and ch not in MUTED:
                part[ch] = True
                note(f"now participating in channel: {ch}")
                cutoff = max(mine)
                for m in ms:
                    if (m.get("id") or 0) > cutoff and m.get("sender") != INSTANCE:
                        emit(ch, m)
            last[ch] = newest(ms, last[ch])
    except BusUnreachable as err:
        # A poll the bus did not answer is transient: a restart, a timeout. It goes to stderr
        # and never to stdout, because a stdout line is a wake-up and an outage is not a
        # message. One note per channel, and one when the channel answers again.
        if ch not in away:
            away.add(ch)
            sys.stderr.write(f"bus-watch: Channel {ch} could not be polled. {err}\n")
            sys.stderr.flush()
    except Exception as err:
        # Anything else is the watcher failing at its own job. Swallowed, it leaves a process
        # that polls forever and wakes nobody, alive from every angle and silent for a reason
        # no reader can see. So it stops here and names what went wrong.
        fatal(f"polling channel {ch} failed", err)
    else:
        if ch in away:
            away.discard(ch)
            sys.stderr.write(f"bus-watch: Channel {ch} can be polled again.\n")
            sys.stderr.flush()

sync_channels()
_watched = sorted(c for c in last if part.get(c))
_silent  = sorted(c for c in last if not part.get(c))
_mode = (", exit-on-message" if EXIT_ON_MESSAGE else "") + (", resumed" if resumed is not None else "")
note(f"armed (filter={FILTER}{_mode}) emitting={','.join(_watched)} "
     f"silent-scan={','.join(_silent)} baselines={json.dumps(last)}")
warn_unresumed()
if started:
    save_cursor()

# Every line is printed with flush, so a saved position never covers a line still in a buffer.
if ONCE:
    for ch in list(last.keys()):
        poll(ch)
    save_cursor()
    sys.exit(0)

while True:
    # Everything inside poll() and sync_channels() already tolerates a bus that is briefly away, so
    # a fault arriving HERE is the watcher itself and it stops the watch. This except exists to put
    # the reason in the log, never to swallow it: a caught fault that let the loop continue would be
    # the silent wedge this whole file exists to prevent.
    emitted = 0
    try:
        for ch in sync_channels():
            poll(ch)
    except Exception as exc:
        fatal("a poll round failed", exc)
    if started:
        save_cursor()
    if EXIT_ON_MESSAGE and emitted:
        note(f"woke the session with {emitted} message(s), exiting")
        sys.exit(0)
    time.sleep(POLL_S)
