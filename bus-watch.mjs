// cross-claude bus watcher. Polls the cross-claude-mcp REST API and prints ONE
// line per NEW message not sent by this instance. Intended to be run under
// Claude Code's `Monitor` tool (persistent): each printed line becomes an
// event/notification, so the main loop is woken ONLY when a real message
// arrives — no fixed-interval chat spam. Between messages it polls quietly in
// the background. Re-arm with:
//   Monitor(persistent:true, command:'node /path/to/bus-watch.mjs')
// Use `--once` for a single poll round (testing).
//
// Configuration (env vars, each with a build-server-local default so the
// original re-arm command keeps working there unchanged):
//   CROSS_CLAUDE_URL      bus base URL   (remote boxes: https://build.ateonet.work:8443)
//   CROSS_CLAUDE_INSTANCE this machine's bus instance id (skip messages from self)
//   CROSS_CLAUDE_TOKEN    bearer token; if unset, read MCP_API_KEY from CROSS_CLAUDE_CFG
//   CROSS_CLAUDE_CFG      env-file fallback for the token
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

const CFG      = process.env.CROSS_CLAUDE_CFG      || 'D:/Ops/cross-claude-mcp/service-config.env';
const BASE     = process.env.CROSS_CLAUDE_URL      || 'http://127.0.0.1:8788';
const INSTANCE = process.env.CROSS_CLAUDE_INSTANCE || 'build-server';
const POLL_MS  = Number(process.env.CROSS_CLAUDE_POLL_MS) || 20000;
const FILTER   = (process.env.CROSS_CLAUDE_FILTER || 'participant').trim().toLowerCase();
const MAXLEN   = 600;
const ONCE     = process.argv.includes('--once');

function readToken() {
  if (process.env.CROSS_CLAUDE_TOKEN) return process.env.CROSS_CLAUDE_TOKEN.trim();
  const line = fs.readFileSync(CFG, 'utf8').split(/\r?\n/).find(l => /^MCP_API_KEY=/i.test(l));
  return line ? line.split('=').slice(1).join('=').trim() : '';
}
const HEADERS = { Authorization: 'Bearer ' + readToken() };

async function getJSON(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const last = {};          // channel -> last seen message id
let started = false;      // startup baselining done?

const part = {};  // channel -> true (emit) / false (silent scan); absent = unclassified, retry

async function listChannels() {
  const j = await getJSON(`${BASE}/api/channels`);
  return (j.channels || []).map(c => c.name).filter(Boolean);
}

async function headOf(ch) {
  try { const j = await getJSON(`${BASE}/api/messages/${ch}?limit=1`); return j.last_id ?? 0; }
  catch { return 0; }
}

async function classify(ch) {
  // -> true/false participant verdict, or null on transient error (retry next round).
  if (FILTER !== 'participant' || ch === 'general') return true;
  try {
    const j = await getJSON(`${BASE}/api/messages/${ch}?limit=500`);
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
      const j = await getJSON(`${BASE}/api/messages/${ch}?after_id=${last[ch]}&instance_id=${INSTANCE}`);
      const msgs = j.messages || [];
      if (msgs.length) { for (const m of msgs) emit(ch, m); last[ch] = j.last_id ?? last[ch]; }
    } else {
      // silent scan: same poll WITHOUT instance_id so our own sends are visible;
      // our first own message graduates the channel (and emits peers' messages after it)
      const j = await getJSON(`${BASE}/api/messages/${ch}?after_id=${last[ch]}`);
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
