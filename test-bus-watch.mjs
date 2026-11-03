#!/usr/bin/env node

/**
 * Watcher test: both twins, bus-watch.mjs and bus-watch.py, run against a throwaway bus and
 * must behave alike. It covers the one-wake mode a session arms as a background command:
 * the run ends on its first messages and nothing else, the next run resumes from the saved
 * read position so a message that arrived between two runs is never missed in any channel,
 * a damaged position stops the watcher loudly, and a position one twin saved is resumed by
 * the other.
 *
 * The bus runs in HTTP mode on an isolated SQLite database in a temp directory, and the
 * watchers run from copies in that directory, so their logs and saved positions never land
 * in this checkout. The python twin is found as CROSS_CLAUDE_PYTHON, python3 or python; with
 * none of them the python cases are reported as skipped, never as passed.
 */

import { spawn, spawnSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync, copyFileSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 9877;
const TOKEN = "watcher-test-token";
const BASE = `http://127.0.0.1:${PORT}`;
const PEER = "test.peer";

const TEST_HOME = mkdtempSync(join(tmpdir(), "cross-claude-watch-"));
copyFileSync(join(__dirname, "bus-watch.mjs"), join(TEST_HOME, "bus-watch.mjs"));
copyFileSync(join(__dirname, "bus-watch.py"), join(TEST_HOME, "bus-watch.py"));

let passed = 0;
let failed = 0;
let skipped = 0;

// A failure prints what the watcher run said, since the run is gone by the time anyone reads it.
function assert(condition, label, run) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    if (run) {
      console.log(`    Exit code: ${run.code}`);
      console.log(`    Stdout: ${run.stdout.trim()}`);
      console.log(`    Stderr: ${run.stderr.trim()}`);
    }
    failed++;
  }
}

function findPython() {
  for (const cmd of [process.env.CROSS_CLAUDE_PYTHON, "python3", "python"].filter(Boolean)) {
    const r = spawnSync(cmd, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf-8" });
    if (r.status === 0 && r.stdout.trim() === "3") return cmd;
  }
  return null;
}

const PYTHON = findPython();
const TWINS = [
  { name: "node", cmd: process.execPath, script: join(TEST_HOME, "bus-watch.mjs") },
  ...(PYTHON ? [{ name: "python", cmd: PYTHON, script: join(TEST_HOME, "bus-watch.py") }] : []),
];

// A DATABASE_URL in the environment would point the throwaway bus at a real PostgreSQL bus.
const { DATABASE_URL: _ignored, ...BASE_ENV } = process.env;
const WATCH_ENV = {
  ...BASE_ENV,
  HOME: TEST_HOME,
  USERPROFILE: TEST_HOME,
  CROSS_CLAUDE_URL: BASE,
  CROSS_CLAUDE_TOKEN: TOKEN,
  CROSS_CLAUDE_CFG: join(TEST_HOME, "no-such-config"),
  CROSS_CLAUDE_POLL_MS: "300",
  CROSS_CLAUDE_FILTER: "participant",
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(channel, sender, content) {
  const res = await fetch(`${BASE}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ channel, sender, content }),
  });
  if (!res.ok) throw new Error(`Posting to ${channel} failed: HTTP ${res.status}`);
  return (await res.json()).id;
}

// Starts one watcher run and returns a handle that collects its output and resolves `done`
// with the exit code once the process ends.
function startWatcher(twin, args) {
  const child = spawn(twin.cmd, [twin.script, ...args], { env: WATCH_ENV, stdio: ["ignore", "pipe", "pipe"] });
  const run = { child, stdout: "", stderr: "", code: undefined };
  child.stdout.on("data", d => { run.stdout += d.toString(); });
  child.stderr.on("data", d => { run.stderr += d.toString(); });
  // 'close' rather than 'exit': it waits for the output pipes to drain, so every line is read.
  run.done = new Promise(resolve => child.on("close", code => { run.code = code; resolve(code); }));
  return run;
}

async function waitFor(predicate, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

async function finish(run, ms) {
  const ended = await Promise.race([run.done.then(() => true), sleep(ms).then(() => false)]);
  if (!ended) { run.child.kill(); await run.done; }
  return ended;
}

const lines = run => run.stdout.split(/\r?\n/).filter(l => l.includes("cross-claude ["));
const cursorOf = id => join(TEST_HOME, "logs", `bus-watch-${id}.cursor.json`);
function savedCursor(id) {
  try { return JSON.parse(readFileSync(cursorOf(id), "utf-8")); } catch { return null; }
}

async function testTwin(twin) {
  console.log(`\n[${twin.name}]`);
  const id = `test.${twin.name}`;
  const work = `work-${twin.name}`;
  const fresh = `fresh-${twin.name}`;

  // A run that must succeed sits in the same suite as the refusal, so a shell that mangled
  // every argument could not make both outcomes look alike.
  const bare = startWatcher(twin, ["--exit-on-message"]);
  await finish(bare, 10000);
  assert(bare.code === 2, "A missing --instance is refused with exit 2", bare);

  await post(work, id, "This session works here.");

  // First arm: no saved position, so it starts from the newest message.
  let run = startWatcher(twin, ["--instance", id, "--exit-on-message"]);
  assert(await waitFor(() => run.stderr.includes("armed"), 10000), "The first arm reports itself armed", run);
  await post("general", id, "The session's own post.");
  await sleep(1500);
  assert(run.code === undefined, "The session's own message does not end the run", run);
  const hello = await post("general", PEER, "Hello from a peer.");
  assert(await finish(run, 10000), "A peer's message ends the run", run);
  assert(run.code === 0, "The run that woke exits 0", run);
  assert(lines(run).length === 1 && run.stdout.includes("Hello from a peer."), "The wake prints the peer's message alone", run);
  assert(savedCursor(id)?.channels?.general === hello, "The saved position is the message that woke the run", run);

  // Between two runs: messages in a channel the session is in, in the rendezvous channel, and in
  // a channel created after the position was saved, which the session posts in and a peer answers.
  await post("general", PEER, "Gap message in general.");
  await post(work, PEER, "Gap message in the work channel.");
  await post(fresh, id, "The session opens a new channel.");
  await post(fresh, PEER, "Gap message in the new channel.");

  run = startWatcher(twin, ["--instance", id, "--exit-on-message", "--resume"]);
  assert(await finish(run, 10000), "A resumed run ends at once on what arrived between runs", run);
  assert(run.code === 0, "The resumed run exits 0", run);
  const gap = lines(run);
  assert(gap.length === 3, `Every message from between the runs is printed in one wake (got ${gap.length})`, run);
  assert(gap.some(l => l.includes("Gap message in general.")), "The gap message in general arrives", run);
  assert(gap.some(l => l.includes("Gap message in the work channel.")), "The gap message in a channel the session is in arrives", run);
  assert(gap.some(l => l.includes("Gap message in the new channel.")), "The gap message in a channel created between runs arrives", run);
  assert(!run.stdout.includes("The session opens a new channel."), "The session's own message between runs is not printed", run);
  const emitting = savedCursor(id)?.emitting || [];
  assert(emitting.includes(work) && emitting.includes(fresh), "The saved position names the channels that wake the session", run);

  // A single round that resumes saves what it printed, so the next run does not print it again.
  await post("general", PEER, "Read by a single round.");
  run = startWatcher(twin, ["--instance", id, "--once", "--resume"]);
  await finish(run, 10000);
  assert(run.code === 0 && lines(run).length === 1, "A resumed single round prints what arrived", run);
  run = startWatcher(twin, ["--instance", id, "--once", "--resume"]);
  await finish(run, 10000);
  assert(run.code === 0 && lines(run).length === 0, "The next resumed run does not print it again", run);

  // Nothing new: a resumed run keeps waiting rather than ending.
  run = startWatcher(twin, ["--instance", id, "--exit-on-message", "--resume"]);
  await sleep(1500);
  assert(run.code === undefined, "A resumed run with nothing new keeps waiting", run);
  await finish(run, 0);

  // Without --resume the run starts from the newest message, so what arrived before it is not printed.
  await post("general", PEER, "Posted before a plain arm.");
  run = startWatcher(twin, ["--instance", id, "--once"]);
  await finish(run, 10000);
  assert(run.code === 0 && lines(run).length === 0, "Without --resume the run starts from the newest message", run);
  assert(run.stderr.includes("is not resumed"), "A run that replaces a saved position says so", run);

  // A damaged saved position stops the watcher loudly instead of guessing where to start.
  for (const [damage, text] of [["unreadable", "not json"], ["holding a position that is not a number", '{"channels":{"general":"x"}}']]) {
    writeFileSync(cursorOf(id), text);
    run = startWatcher(twin, ["--instance", id, "--exit-on-message", "--resume"]);
    await finish(run, 10000);
    assert(run.code === 1 && run.stdout.includes("stopped") && run.stdout.includes("damaged"),
      `A saved position ${damage} stops the run with exit 1 and a line saying it is damaged`, run);
  }
  rmSync(cursorOf(id), { force: true });
}

async function testHandOff(from, to) {
  console.log(`\n[${from.name} saves, ${to.name} resumes]`);
  const id = `test.handoff`;
  let run = startWatcher(from, ["--instance", id, "--exit-on-message"]);
  await waitFor(() => run.stderr.includes("armed"), 10000);
  await post("general", PEER, "Wake the first twin.");
  await finish(run, 10000);
  assert(run.code === 0, `The ${from.name} run wakes and exits 0`, run);
  await post("general", PEER, "Arrived between the twins.");
  run = startWatcher(to, ["--instance", id, "--exit-on-message", "--resume"]);
  await finish(run, 10000);
  assert(run.code === 0 && lines(run).length === 1 && run.stdout.includes("Arrived between the twins."),
    `The ${to.name} run resumes from the position the ${from.name} run saved`, run);
}

const server = spawn(process.execPath, [join(__dirname, "server.mjs")], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...BASE_ENV, PORT: String(PORT), MCP_API_KEY: TOKEN, HOME: TEST_HOME, USERPROFILE: TEST_HOME },
});

try {
  console.log("Starting watcher test suite...");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server start timeout")), 10000);
    server.stdout.on("data", d => {
      if (d.toString().includes("listening on port")) { clearTimeout(timeout); resolve(); }
    });
  });

  for (const twin of TWINS) await testTwin(twin);
  if (PYTHON) {
    await testHandOff(TWINS[0], TWINS[1]);
    await testHandOff(TWINS[1], TWINS[0]);
  } else {
    console.log("\n  SKIP: No python3 found, so the python twin was not tested. Set CROSS_CLAUDE_PYTHON to test it.");
    skipped++;
  }
} catch (err) {
  console.log(`  FAIL: ${err.message}`);
  failed++;
} finally {
  server.kill();
  await sleep(300);
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* a file still held open on Windows */ }
}

console.log(`\nResults: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed ? 1 : 0);
