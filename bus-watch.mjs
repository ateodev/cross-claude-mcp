// cross-claude bus watcher. Polls the cross-claude-mcp REST API and prints ONE
// line per NEW message not sent by this instance. Between messages it polls
// quietly, so a session is woken only when a real message arrives.
//
// How it runs:
//   --exit-on-message  as a background command that ENDS on the first poll round
//                      that found messages, after printing every one of them. The
//                      session wakes once per batch on the command's completion,
//                      never on a timer, and re-arms with --resume.
//   (neither flag)     as an endless stream, one event per line, for a host that
//                      keeps a streaming watch alive.
//   --resume           start from the read position the last run of this instance id
//                      saved, with the channels that woke it, so nothing that arrived
//                      between two runs is missed, in any channel. Without it the
//                      watcher starts from the newest message. Pass it on a RE-arm
//                      only: on a session's first arm, a position saved under the
//                      same id by an earlier session would replay its messages.
//   --once             a single poll round, then exit 0 (a connectivity test).
//
// Exit codes: 0 after printing messages under --exit-on-message, after --once, or
// when stopped by a signal, so a 0 with no message line means something outside
// stopped it. 1 means it stopped itself over a fault, after printing one line that
// says so and writing the reason to its log. 2 means --instance was missing.
//
// Configuration — all env vars are optional on a machine that has the cross-claude
// MCP server configured, because the bus URL and token are read from that config.
// The instance id is the exception: it is REQUIRED on argv, see below.
//   CROSS_CLAUDE_URL      bus base URL (overrides the configured one)
//   CROSS_CLAUDE_TOKEN    bearer token — prefer a config file, since env on a command
//                         line is visible in the process list
//   CROSS_CLAUDE_CFG      config file, in either shape: a Claude client config (the
//                         cross-claude MCP entry carries both url and auth header) or
//                         an env file with BUS_URL= / MCP_API_KEY=. Read before, and
//                         in addition to, ~/.claude.json
//   CROSS_CLAUDE_POLL_MS  poll interval
//   CROSS_CLAUDE_FILTER   "participant" (default) or "all" — see below
//
// Channels are discovered DYNAMICALLY from GET /api/channels every round — a
// hardcoded channel list silently hears nothing when the work moves to a new
// channel. Channels existing at startup are baselined at their current last_id
// (no history replay); channels that appear later start from 0 so their very
// first messages are not missed.
//
// Only MESSAGES wake a session. A channel's pinned text is metadata on the
// channel record: the channel listing carries has_pin and never the text, and a
// message poll never carries it either, so pinning or replacing a text emits
// nothing here. A session that wants that text reads it deliberately.
//
// Only messages reach stdout. Everything else goes to stderr: a poll the bus did
// not answer is noted once per channel, and once more when that channel answers
// again. A failure that stops this watcher doing its one job ends the process with
// a line saying what failed, because a watcher that cannot emit must never look
// like a quiet bus.
//
// Channel FILTER (multi-machine buses): with more than two instances on the
// bus, watching every channel wakes an instance for conversations between
// OTHER peers. CROSS_CLAUDE_FILTER=participant (default) EMITS only for
// #general (the rendezvous channel) plus channels this INSTANCE participates
// in. The REST /api/channels payload carries no participants field, so
// participation is determined client-side: at classification time the
// channel's history is scanned for a message sent by INSTANCE; non-participant
// channels are still POLLED (same API cost) but silently — their deltas are
// scanned for INSTANCE's own sender id, and the first own message GRADUATES
// the channel to emitting (messages after it in the same delta are emitted
// too, so a peer reply that lands in the same poll round is not lost). The
// rendezvous convention makes this safe: first contact / channel switches are
// announced in #general, and your reply in a channel is exactly what makes it
// wake you afterwards. Set CROSS_CLAUDE_FILTER=all for the old
// watch-everything behavior.
//
// Two argv lists override that classification per session:
//   --mute <a,b>    never emit for these channels, whatever the filter says.
//                   #general is the one the filter cannot drop on its own, and a
//                   session whose work has moved to its own channel does not want
//                   waking by unrelated announcements there.
//   --always <a,b>  always emit for these, skipping the participant verdict. The
//                   verdict reads history, and history expires with the server's
//                   retention, so a channel the session must never miss is named
//                   here rather than left to evidence that ages out.
// Mute wins over always. Both are still POLLED, like any other channel.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const POLL_MS  = Number(process.env.CROSS_CLAUDE_POLL_MS) || 20000;
const FILTER   = (process.env.CROSS_CLAUDE_FILTER || 'participant').trim().toLowerCase();
// The id belongs to the SESSION that arms this watcher, not to the machine, so it MUST
// arrive on argv: a launcher or an env var cannot carry a value that differs per session.
// There is deliberately NO fallback. Every implicit source yields a WRONG id rather than a
// missing one — an env var holds a machine-wide name, and the hostname is either the bare
// machine prefix (an id the protocol forbids) or a name no session ever registered, e.g. an
// mDNS `*.local`. Both look plausible, and the failure is silent in the worst direction: an
// unregistered id matches nothing in the self-filter, so the watcher wakes you for your OWN
// messages, while the participant filter finds no channel that id has posted in, so it stays
// quiet for the peer you are waiting on. That is indistinguishable from a quiet bus.
// Assert the value was passed rather than checking its shape: a shape check cannot tell a
// deliberate id from a hostname that happens to look like one.
const instanceAt = process.argv.indexOf('--instance');
const INSTANCE   = (instanceAt >= 0 ? (process.argv[instanceAt + 1] || '') : '').trim().toLowerCase();
if (!INSTANCE || INSTANCE.startsWith('--')) {
  console.error('bus-watch: --instance <prefix>.<suffix> is required (the id belongs to this session, not the machine).');
  process.exit(2);
}
const MAXLEN   = 600;
const ONCE     = process.argv.includes('--once');
const EXIT_ON_MESSAGE = process.argv.includes('--exit-on-message');
const RESUME   = process.argv.includes('--resume');

// Per-session channel choices, on argv for the same reason the instance id is: they belong to what
// THIS session is doing, not to the machine. --mute names channels that never emit however the
// filter classifies them; --always names channels that emit regardless of the participant verdict.
// Mute wins over always: a deliberate silence outranks a deliberate noise.
// --mute exists because the participant filter cannot drop the rendezvous channel, and a session
// whose work has moved to its own channel is woken by every unrelated announcement there.
// --always exists because a participant verdict is evidence-based and the evidence expires: the
// server deletes messages past its retention window, so a channel this instance posted in months
// ago silently stops waking it. Naming it here is the standing answer for a channel the session
// must never miss.
function listArg(name) {
  const at = process.argv.indexOf(name);
  const raw = at >= 0 ? (process.argv[at + 1] || '') : '';
  return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(s => s && !s.startsWith('--')));
}
const MUTED  = listArg('--mute');
const ALWAYS = listArg('--always');

// --- Failure reporting. This watcher IS an unattended session's liveness mechanism, so its own
// death must never be silent: a watcher that is gone looks exactly like a quiet bus. Three rules
// follow from that. Every diagnostic goes to a FILE beside this script as well as to stderr,
// because the harness's pipes are themselves a suspect whenever a watcher dies with no trace, and
// a stack written to a broken pipe is lost exactly when it is needed. Every write out of this
// process is guarded, so reporting a failure can never be the thing that ends the watch. And a
// fault the watcher cannot classify as a transient bus STOPS it, with the reason in the log first:
// the same rule the unemittable-line handler above follows, because a watcher carrying an unknown
// fault must not keep polling as though it were healthy. Stopping is visible (the harness reports
// the task ended) and silence is not, which is the whole distinction this file is built around.
//
// Reading the log after a death: a line naming a signal means something stopped the watcher on
// purpose. A crash line means the watcher's own code failed and the stack says where. A log that
// simply STOPS, with no line of either kind, means the process was terminated without warning
// (a hard kill, which no handler can catch), so look at what was managing it rather than here.
const LOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'logs', `bus-watch-${INSTANCE}.log`);
function note(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()} [${INSTANCE}] ${line}\n`);
  } catch { /* a log that cannot be written is not allowed to be what kills the watcher */ }
  try { process.stderr.write(`bus-watch: ${line}\n`); } catch { /* broken pipe: the file holds it */ }
}
// The log line goes first and the event second, because the file is the copy that survives a pipe
// the harness has already taken away. Then the process ends: a fault nobody classified is not
// something to poll through.
function fatal(what, err) {
  const detail = err && err.stack ? String(err.stack).replace(/\s+/g, ' ') : String(err);
  note(`Stopping, ${what}: ${detail}`);
  try { console.log(`🔔 cross-claude bus-watch [${INSTANCE}] stopped, ${what}. Re-arm it; the reason is in ${LOG}`); } catch { /* no channel left to say it on */ }
  process.exit(1);
}
process.on('uncaughtException', e => fatal('uncaught exception', e));
process.on('unhandledRejection', e => fatal('unhandled rejection', e));
process.on('exit', code => { if (code !== 0) note(`exiting with code ${code}`); });
for (const sig of ['SIGTERM', 'SIGINT', 'SIGBREAK', 'SIGHUP']) {
  try { process.on(sig, () => { note(`stopped by ${sig}`); process.exit(0); }); } catch { /* not every signal exists on every platform */ }
}

// --- The read position, per channel, that one run hands to the next, together with the channels
// that wake the session, so a resumed run continues exactly as the last one stood: a participant
// verdict re-derived from history would forget a channel whose own post has aged out of it. It is
// written after every round that moved it, so a run stopped from outside still leaves the last
// position it reached. A position that cannot be written, or one that cannot be read back, stops
// the watcher: either would lose messages in silence between two runs.
const CURSOR = path.join(path.dirname(LOG), `bus-watch-${INSTANCE}.cursor.json`);
let savedText = '';
function saveCursor() {
  const channels = last;
  const emitting = Object.keys(part).filter(c => part[c]).sort();
  const text = JSON.stringify({ channels, emitting });
  if (text === savedText) return;
  try {
    fs.mkdirSync(path.dirname(CURSOR), { recursive: true });
    fs.writeFileSync(CURSOR + '.tmp', JSON.stringify({ instance: INSTANCE, saved: new Date().toISOString(), channels, emitting }));
    fs.renameSync(CURSOR + '.tmp', CURSOR);
  } catch (err) { fatal(`the read position could not be saved to ${CURSOR}`, err); }
  savedText = text;
}
function loadCursor() {
  let text;
  try { text = fs.readFileSync(CURSOR, 'utf8'); }
  catch (err) {
    if (err.code !== 'ENOENT') fatal(`the saved read position in ${CURSOR} could not be read`, err);
    note('no saved read position for this id, starting from the newest message');
    return null;
  }
  try {
    const { channels, emitting = [] } = JSON.parse(text);
    if (!channels || typeof channels !== 'object' || Array.isArray(channels)) throw new Error('no channels in the file');
    for (const [ch, id] of Object.entries(channels)) {
      if (!Number.isInteger(id) || id < 0) throw new Error(`channel ${ch} has no valid position`);
    }
    if (!Array.isArray(emitting) || emitting.some(c => typeof c !== 'string')) throw new Error('the waking channels are not a list of names');
    return { channels, emitting: new Set(emitting) };
  } catch (err) { fatal(`the saved read position in ${CURSOR} is damaged; delete it to start from the newest message`, err); }
}
// A run that does not resume starts from the newest message, and a position it replaces is gone,
// so the replacement is said where the session will look for it.
function warnUnresumed() {
  if (!RESUME && fs.existsSync(CURSOR)) note(`a saved read position exists and is not resumed, so messages since it are skipped; pass --resume to continue from it`);
}

// Reads either config shape: a Claude client config, whose cross-claude MCP entry
// carries both the bus URL and the auth header, or an env file with BUS_URL= /
// MCP_API_KEY=. An unreadable file yields nothing rather than throwing — another
// source, or the environment, may supply the missing half.
function readConfig(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  if (text.trimStart().startsWith('{')) {
    try {
      const entry = JSON.parse(text)?.mcpServers?.['cross-claude'];
      return { url: entry?.url || '', auth: entry?.headers?.Authorization || '' };
    } catch { return {}; }
  }
  const value = key => {
    const line = text.split(/\r?\n/).find(l => new RegExp(`^${key}=`, 'i').test(l));
    return line ? line.split('=').slice(1).join('=').trim() : '';
  };
  return { url: value('BUS_URL'), auth: value('MCP_API_KEY') };
}

const CONFIGS = [process.env.CROSS_CLAUDE_CFG, path.join(os.homedir(), '.claude.json')].filter(Boolean);
const cfg = CONFIGS.map(readConfig).reduce((a, c) => ({ url: a.url || c.url, auth: a.auth || c.auth }), { url: '', auth: '' });

// The configured MCP endpoint ends in /mcp; the REST API this polls sits next to it.
const BASE = (process.env.CROSS_CLAUDE_URL || cfg.url || '').trim().replace(/\/+$/, '').replace(/\/mcp$/i, '');
const AUTH = (process.env.CROSS_CLAUDE_TOKEN || cfg.auth || '').trim();
if (!BASE || !AUTH) {
  const missing = [!BASE && 'bus URL', !AUTH && 'token'].filter(Boolean).join(' and ');
  throw new Error(`cross-claude ${missing} not found: configure the cross-claude MCP server on this machine, or set CROSS_CLAUDE_URL / CROSS_CLAUDE_TOKEN / CROSS_CLAUDE_CFG (looked in ${CONFIGS.join(', ')})`);
}
const HEADERS = { Authorization: AUTH.startsWith('Bearer ') ? AUTH : 'Bearer ' + AUTH };

// Every way the bus can fail to answer is raised as one type, so a caller can tell a bus that
// is briefly away from a fault in the watcher itself. Everything this function can raise is a
// transport or a parse failure, which is what makes the whole body one boundary.
class BusUnreachable extends Error {}
async function getJSON(url) {
  try {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new BusUnreachable('HTTP ' + r.status);
    return await r.json();
  } catch (err) {
    throw err instanceof BusUnreachable ? err : new BusUnreachable(`${err.name}: ${err.message}`, { cause: err });
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const last = {};          // channel -> last seen message id
let started = false;      // has the channel list been read once?
let emitted = 0;          // message lines printed in the current round
const resumed = RESUME ? loadCursor() : null;  // { channels: position per channel, emitting: Set }

const part = {};  // channel -> true (emit) / false (silent scan); absent = unclassified, retry
const away = new Set();  // channels whose last poll the bus did not answer, so the note is printed once
const unbaselined = new Set();  // channels whose newest message could not be read yet

// A watcher that cannot print its line wakes nobody, and from outside that reads exactly like
// an idle bus. A stdout that stops accepting writes therefore stops the watcher, loudly.
process.stdout.on('error', err => {
  note(`Stopped, a message line could not be printed. ${err.name}: ${err.message}`);
  process.exit(1);
});

// Channel names and instance ids reach the server as URL components, so they are
// escaped: an id carries a dot-separated session suffix, and an unescaped '#' or '&'
// would truncate the value silently rather than fail.
const enc = encodeURIComponent;

async function listChannels() {
  const j = await getJSON(`${BASE}/api/channels`);
  return (j.channels || []).map(c => c.name).filter(Boolean);
}

async function headOf(ch) {
  // A window rather than one message, since the newest by time may not be the newest by id.
  // null when the bus did not answer: a channel is never baselined at 0 by accident, which would
  // replay its whole history.
  try { return newest(byId(await getJSON(`${BASE}/api/messages/${enc(ch)}?limit=50`)), 0); }
  catch (err) { if (err instanceof BusUnreachable) return null; throw err; }
}

async function classify(ch) {
  // -> true/false participant verdict, or null on transient error (retry next round).
  // The two explicit lists are decided first and never hit the network: they are the session's
  // own instruction, not something to be re-derived from the channel's history each round.
  if (MUTED.has(ch)) return false;
  if (ALWAYS.has(ch)) return true;
  if (FILTER !== 'participant' || ch === 'general') return true;
  if (resumed && resumed.emitting.has(ch)) return true;
  try {
    const j = await getJSON(`${BASE}/api/messages/${enc(ch)}?limit=500`);
    return (j.messages || []).some(m => m.sender === INSTANCE);
  } catch (err) { if (err instanceof BusUnreachable) return null; throw err; }
}

async function syncChannels() {
  // Discover channels each round; tolerate transient failures (keep last known set).
  let names;
  try { names = await listChannels(); }
  catch (err) { if (err instanceof BusUnreachable) return Object.keys(last); throw err; }
  for (const ch of names) {
    if (!(ch in last)) {
      if (resumed && ch in resumed.channels) {
        last[ch] = resumed.channels[ch];  // resume: continue exactly where the last run stopped
      } else if ((!started && !resumed) || unbaselined.has(ch)) {
        // startup: baseline at head, no history replay. A channel whose head could not be read
        // stays out of the watch until it can, rather than starting from its beginning.
        const head = await headOf(ch);
        if (head === null) { unbaselined.add(ch); continue; }
        unbaselined.delete(ch);
        last[ch] = head;
      } else {
        // Appeared mid-run, or since the saved position: brand new, deliver from the beginning.
        last[ch] = 0;
        note(`new channel discovered: ${ch}`);
      }
    }
    if (!(ch in part)) {
      const verdict = await classify(ch);
      if (verdict !== null) part[ch] = verdict;
    }
  }
  // Only a list the bus answered ends startup, so a channel missing from a failed first read is
  // still baselined at head later rather than replayed from its beginning.
  started = true;
  return Object.keys(last);
}

// The bus orders a channel's messages by time, and two posted within one tick of its clock come
// back in either order, so its own last_id can name a message older than one it just returned.
// The read position is therefore the highest id actually received, and messages print in id order.
function byId(j) {
  return (j.messages || []).slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}
function newest(msgs, floor) {
  return msgs.reduce((top, m) => Math.max(top, m.id ?? 0), floor);
}

function emit(ch, m) {
  const c = String(m.content).replace(/\s+/g, ' ').trim().slice(0, MAXLEN);
  // one line == one event/notification
  console.log(`🔔 cross-claude [${ch} #${m.id} ${m.message_type}] ${m.sender}: ${c}`);
  emitted++;
}

async function poll(ch) {
  // An unclassified channel is not polled: a silent scan would move its position past messages
  // that a participant verdict, once the bus answers, should have printed.
  if (!(ch in part)) return;
  try {
    if (part[ch]) {
      // participating channel: emit every new peer message (server drops our own)
      const msgs = byId(await getJSON(`${BASE}/api/messages/${enc(ch)}?after_id=${last[ch]}&instance_id=${enc(INSTANCE)}`));
      for (const m of msgs) emit(ch, m);
      last[ch] = newest(msgs, last[ch]);
    } else {
      // silent scan: same poll WITHOUT instance_id so our own sends are visible;
      // our first own message graduates the channel (and emits peers' messages after it)
      const msgs = byId(await getJSON(`${BASE}/api/messages/${enc(ch)}?after_id=${last[ch]}`));
      const mine = msgs.filter(m => m.sender === INSTANCE).map(m => m.id ?? 0);
      // Graduation never lifts a mute. Mute is the session's own instruction and it outranks every
      // verdict including this one, because the ordinary way a session touches a muted channel is to
      // POST in it, such as a status in the rendezvous channel it does not want waking on.
      if (mine.length && !MUTED.has(ch)) {
        part[ch] = true;
        note(`now participating in channel: ${ch}`);
        const cutoff = Math.max(...mine);
        for (const m of msgs) {
          if ((m.id ?? 0) > cutoff && m.sender !== INSTANCE) emit(ch, m);
        }
      }
      last[ch] = newest(msgs, last[ch]);
    }
    if (away.has(ch)) {
      away.delete(ch);
      process.stderr.write(`bus-watch: Channel ${ch} can be polled again.\n`);
    }
  } catch (err) {
    if (err instanceof BusUnreachable) {
      // A poll the bus did not answer is transient: a restart, a timeout. It goes to stderr
      // and never to stdout, because a stdout line is a wake-up and an outage is not a
      // message. One note per channel, and one when the channel answers again.
      if (!away.has(ch)) {
        away.add(ch);
        process.stderr.write(`bus-watch: Channel ${ch} could not be polled. ${err.message}\n`);
      }
      return;
    }
    // Anything else is the watcher failing at its own job. Swallowed, it leaves a process
    // that polls forever and wakes nobody, alive from every angle and silent for a reason
    // no reader can see. So it stops here and names what went wrong.
    fatal(`polling channel ${ch} failed`, err);
  }
}

await syncChannels();
// readiness note on stderr and in the log, never an event line
const watched = Object.keys(last).filter(c => part[c]).sort();
const silent  = Object.keys(last).filter(c => !part[c]).sort();
note(`armed (filter=${FILTER}${EXIT_ON_MESSAGE ? ', exit-on-message' : ''}${resumed ? ', resumed' : ''}) emitting=${watched.join(',')} silent-scan=${silent.join(',')} baselines=${JSON.stringify(last)}`);
warnUnresumed();
if (started) saveCursor();

// A pipe on some platforms takes writes asynchronously, so printed lines are flushed before the
// position that covers them is saved: a run stopped in between prints them again rather than never.
const flushed = () => new Promise(resolve => process.stdout.write('', resolve));

if (ONCE) {
  for (const ch of Object.keys(last)) await poll(ch);
  await flushed();
  saveCursor();
  process.exit(0);
}
while (true) {
  // Everything inside poll() and syncChannels() already tolerates a bus that is briefly away, so a
  // fault arriving HERE is the watcher itself and it stops the watch. This catch exists to put the
  // reason in the log, never to swallow it: a caught fault that let the loop continue would be the
  // silent wedge this whole file exists to prevent.
  emitted = 0;
  try {
    const names = await syncChannels();
    for (const ch of names) await poll(ch);
  } catch (e) { fatal('a poll round failed', e); }
  if (emitted) await flushed();
  if (started) saveCursor();
  if (EXIT_ON_MESSAGE && emitted) {
    note(`woke the session with ${emitted} message(s), exiting`);
    process.exit(0);
  }
  await sleep(POLL_MS);
}
