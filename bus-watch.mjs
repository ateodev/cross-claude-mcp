// cross-claude bus watcher. Polls the cross-claude-mcp REST API and prints ONE
// line per NEW message not sent by this instance. Intended to be run under
// Claude Code's `Monitor` tool (persistent): each printed line becomes an
// event/notification, so the main loop is woken ONLY when a real message
// arrives — no fixed-interval chat spam. Between messages it polls quietly in
// the background. Re-arm with:
//   Monitor(persistent:true, command:'node /path/to/bus-watch.mjs')
// Use `--once` for a single poll round (testing).
//
// Configuration — all env vars are optional on a machine that has the cross-claude
// MCP server configured, because the bus URL and token are read from that config:
//   CROSS_CLAUDE_URL      bus base URL (overrides the configured one)
//   CROSS_CLAUDE_INSTANCE this machine's bus instance id, used to skip messages from
//                         self; defaults to the hostname, lowercased
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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const POLL_MS  = Number(process.env.CROSS_CLAUDE_POLL_MS) || 20000;
const FILTER   = (process.env.CROSS_CLAUDE_FILTER || 'participant').trim().toLowerCase();
// The id belongs to the SESSION that arms this watcher, not to the machine, so it is
// passed per-run on argv — a launcher script cannot carry a value that differs per
// session. Falls back to env, then the hostname.
const argInstance = process.argv.includes('--instance') ? process.argv[process.argv.indexOf('--instance') + 1] : '';
const INSTANCE = (argInstance || process.env.CROSS_CLAUDE_INSTANCE || os.hostname()).trim().toLowerCase();
const MAXLEN   = 600;
const ONCE     = process.argv.includes('--once');

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

async function getJSON(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const last = {};          // channel -> last seen message id
let started = false;      // startup baselining done?

const part = {};  // channel -> true (emit) / false (silent scan); absent = unclassified, retry

// Channel names and instance ids reach the server as URL components, so they are
// escaped: an id carries a dot-separated session suffix, and an unescaped '#' or '&'
// would truncate the value silently rather than fail.
const enc = encodeURIComponent;

async function listChannels() {
  const j = await getJSON(`${BASE}/api/channels`);
  return (j.channels || []).map(c => c.name).filter(Boolean);
}

async function headOf(ch) {
  try { const j = await getJSON(`${BASE}/api/messages/${enc(ch)}?limit=1`); return j.last_id ?? 0; }
  catch { return 0; }
}

async function classify(ch) {
  // -> true/false participant verdict, or null on transient error (retry next round).
  if (FILTER !== 'participant' || ch === 'general') return true;
  try {
    const j = await getJSON(`${BASE}/api/messages/${enc(ch)}?limit=500`);
    return (j.messages || []).some(m => m.sender === INSTANCE);
  } catch { return null; }
}

async function syncChannels() {
  // Discover channels each round; tolerate transient failures (keep last known set).
  let names;
  try { names = await listChannels(); } catch { return Object.keys(last); }
  for (const ch of names) {
    if (!(ch in last)) {
      if (!started) {
        last[ch] = await headOf(ch);  // startup: baseline at head — no history replay
      } else {
        last[ch] = 0;  // appeared mid-run: brand new, deliver from the beginning
        process.stderr.write(`bus-watch: new channel discovered: ${ch}\n`);
      }
    }
    if (!(ch in part)) {
      const verdict = await classify(ch);
      if (verdict !== null) part[ch] = verdict;
    }
  }
  return Object.keys(last);
}

function emit(ch, m) {
  const c = String(m.content).replace(/\s+/g, ' ').trim().slice(0, MAXLEN);
  // one line == one event/notification
  console.log(`🔔 cross-claude [${ch} #${m.id} ${m.message_type}] ${m.sender}: ${c}`);
}

async function poll(ch) {
  try {
    if (part[ch]) {
      // participating channel: emit every new peer message (server drops our own)
      const j = await getJSON(`${BASE}/api/messages/${enc(ch)}?after_id=${last[ch]}&instance_id=${enc(INSTANCE)}`);
      const msgs = j.messages || [];
      if (msgs.length) { for (const m of msgs) emit(ch, m); last[ch] = j.last_id ?? last[ch]; }
    } else {
      // silent scan: same poll WITHOUT instance_id so our own sends are visible;
      // our first own message graduates the channel (and emits peers' messages after it)
      const j = await getJSON(`${BASE}/api/messages/${enc(ch)}?after_id=${last[ch]}`);
      const msgs = j.messages || [];
      const mine = msgs.filter(m => m.sender === INSTANCE).map(m => m.id ?? 0);
      if (mine.length) {
        part[ch] = true;
        process.stderr.write(`bus-watch: now participating in channel: ${ch}\n`);
        const cutoff = Math.max(...mine);
        for (const m of msgs) {
          if ((m.id ?? 0) > cutoff && m.sender !== INSTANCE) emit(ch, m);
        }
      }
      if (msgs.length) last[ch] = j.last_id ?? last[ch];
    }
  } catch { /* transient (server restart, timeout) — ignore, keep watching */ }
}

await syncChannels();
started = true;
// readiness note on stderr (Monitor: stderr -> output file, NOT an event line)
const watched = Object.keys(last).filter(c => part[c]).sort();
const silent  = Object.keys(last).filter(c => !part[c]).sort();
process.stderr.write(`bus-watch armed (filter=${FILTER}) @ ${new Date().toISOString()} emitting=${watched.join(',')} silent-scan=${silent.join(',')} baselines=${JSON.stringify(last)}\n`);

if (ONCE) { for (const ch of Object.keys(last)) await poll(ch); process.exit(0); }
while (true) {
  const names = await syncChannels();
  for (const ch of names) await poll(ch);
  await sleep(POLL_MS);
}
