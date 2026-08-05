#!/usr/bin/env python3
"""Event-driven cross-claude bus watcher (python3 twin of bus-watch.mjs).

Polls the bus REST API and prints ONE stdout line per NEW message so a
persistent Claude Code Monitor wakes the instance only on real messages (no
timer/context spam). Survives context compaction (Monitor is a session-level
background task); dies only on terminal/session close -> re-arm on a fresh
session. Use this on machines without Node; bus-watch.mjs is the Node twin.
Keep the two implementations behaviorally identical.

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

Usage:
  python3 bus-watch.py --instance <prefix>.<suffix> --once   # baseline + one poll, armed line on stderr, exit 0 (connectivity test)
  python3 bus-watch.py --instance <prefix>.<suffix>          # persistent poll loop; for the Monitor tool
"""
import json, os, time, sys, re, urllib.request
from urllib.parse import quote as enc  # channel names and ids are URL components

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

def get_json(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)

last = {}        # channel -> last seen message id
started = False  # startup baselining done?

part = {}  # channel -> True (emit) / False (silent scan); absent = unclassified, retry

def list_channels():
    j = get_json(f"{BASE}/api/channels")
    return [c.get("name") for c in (j.get("channels") or []) if c.get("name")]

def head_of(ch):
    try:
        j = get_json(f"{BASE}/api/messages/{enc(ch)}?limit=1")
        return j.get("last_id") or 0
    except Exception:
        return 0

def classify(ch):
    # -> True/False participant verdict, or None on transient error (retry next round).
    if FILTER != "participant" or ch == "general":
        return True
    try:
        j = get_json(f"{BASE}/api/messages/{enc(ch)}?limit=500")
        return any(m.get("sender") == INSTANCE for m in (j.get("messages") or []))
    except Exception:
        return None

def sync_channels():
    # Discover channels each round; tolerate transient failures (keep last known set).
    try:
        names = list_channels()
    except Exception:
        return list(last.keys())
    for ch in names:
        if ch not in last:
            if not started:
                last[ch] = head_of(ch)  # startup: baseline at head -- no history replay
            else:
                last[ch] = 0  # appeared mid-run: brand new, deliver from the beginning
                sys.stderr.write(f"bus-watch: new channel discovered: {ch}\n")
                sys.stderr.flush()
        if ch not in part:
            verdict = classify(ch)
            if verdict is not None:
                part[ch] = verdict
    return list(last.keys())

def emit(ch, m):
    c = re.sub(r"\s+", " ", str(m.get("content", ""))).strip()[:MAXLEN]
    print(f"\U0001f514 cross-claude [{ch} #{m.get('id')} {m.get('message_type')}] "
          f"{m.get('sender')}: {c}", flush=True)

def poll(ch):
    try:
        if part.get(ch):
            # participating channel: emit every new peer message (server drops our own)
            j = get_json(f"{BASE}/api/messages/{enc(ch)}?after_id={last[ch]}&instance_id={enc(INSTANCE)}")
            ms = j.get("messages") or []
            for m in ms:
                emit(ch, m)
            if ms:
                last[ch] = j.get("last_id") or last[ch]
        else:
            # silent scan: same poll WITHOUT instance_id so our own sends are visible;
            # our first own message graduates the channel (and emits peers' messages after it)
            j = get_json(f"{BASE}/api/messages/{enc(ch)}?after_id={last[ch]}")
            ms = j.get("messages") or []
            mine = [m.get("id") or 0 for m in ms if m.get("sender") == INSTANCE]
            if mine:
                part[ch] = True
                sys.stderr.write(f"bus-watch: now participating in channel: {ch}\n")
                sys.stderr.flush()
                cutoff = max(mine)
                for m in ms:
                    if (m.get("id") or 0) > cutoff and m.get("sender") != INSTANCE:
                        emit(ch, m)
            if ms:
                last[ch] = j.get("last_id") or last[ch]
    except Exception:
        pass  # transient errors must not kill the watcher; stay silent (stderr only would be noise)

sync_channels()
started = True
_watched = sorted(c for c in last if part.get(c))
_silent  = sorted(c for c in last if not part.get(c))
sys.stderr.write(f"bus-watch armed (filter={FILTER}) emitting={','.join(_watched)} "
                 f"silent-scan={','.join(_silent)} baselines={json.dumps(last)}\n")
sys.stderr.flush()

if ONCE:
    for ch in list(last.keys()):
        poll(ch)
    sys.exit(0)

while True:
    for ch in sync_channels():
        poll(ch)
    time.sleep(POLL_S)
