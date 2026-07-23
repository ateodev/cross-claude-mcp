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
//
// Channels are discovered DYNAMICALLY from GET /api/channels every round — a
// hardcoded channel list silently hears nothing when the work moves to a new
// channel. Channels existing at startup are baselined at their current last_id
// (no history replay); channels that appear later start from 0 so their very
// first messages are not missed.
import fs from 'node:fs';

const CFG      = process.env.CROSS_CLAUDE_CFG      || 'D:/Ops/cross-claude-mcp/service-config.env';
const BASE     = process.env.CROSS_CLAUDE_URL      || 'http://127.0.0.1:8788';
const INSTANCE = process.env.CROSS_CLAUDE_INSTANCE || 'build-server';
const POLL_MS  = Number(process.env.CROSS_CLAUDE_POLL_MS) || 20000;
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

async function listChannels() {
  const j = await getJSON(`${BASE}/api/channels`);
  return (j.channels || []).map(c => c.name).filter(Boolean);
}

async function syncChannels() {
  // Discover channels each round; tolerate transient failures (keep last known set).
  let names;
  try { names = await listChannels(); } catch { return Object.keys(last); }
  for (const ch of names) {
    if (ch in last) continue;
    if (!started) {
      // startup: baseline at current head — do not replay history
      try { const j = await getJSON(`${BASE}/api/messages/${ch}?limit=1`); last[ch] = j.last_id ?? 0; }
      catch { last[ch] = 0; }
    } else {
      last[ch] = 0;  // appeared mid-run: brand new, deliver from the beginning
      process.stderr.write(`bus-watch: new channel discovered: ${ch}\n`);
    }
  }
  return names;
}

function emit(ch, m) {
  const c = String(m.content).replace(/\s+/g, ' ').trim().slice(0, MAXLEN);
  // one line == one event/notification
  console.log(`🔔 cross-claude [${ch} #${m.id} ${m.message_type}] ${m.sender}: ${c}`);
}

async function poll(ch) {
  try {
    const j = await getJSON(`${BASE}/api/messages/${ch}?after_id=${last[ch]}&instance_id=${INSTANCE}`);
    const msgs = j.messages || [];
    if (msgs.length) { for (const m of msgs) emit(ch, m); last[ch] = j.last_id ?? last[ch]; }
  } catch { /* transient (server restart, timeout) — ignore, keep watching */ }
}

await syncChannels();
started = true;
// readiness note on stderr (Monitor: stderr -> output file, NOT an event line)
process.stderr.write(`bus-watch armed @ ${new Date().toISOString()} channels=${Object.keys(last).join(',')} baselines=${JSON.stringify(last)}\n`);

if (ONCE) { for (const ch of Object.keys(last)) await poll(ch); process.exit(0); }
while (true) {
  const names = await syncChannels();
  for (const ch of names) await poll(ch);
  await sleep(POLL_MS);
}
