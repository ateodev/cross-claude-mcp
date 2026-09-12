#!/usr/bin/env node

/**
 * Retention test: the sweep that deletes aged messages leaves a channel's pinned text alone.
 *
 * Runs against an isolated SQLite database in a temp directory, and ages rows with a direct
 * UPDATE because nothing on the bus writes a timestamp. It drives the sweep through
 * `node server.mjs --cleanup`, the same entry point a deployment uses by hand, so the
 * guarantee is proven rather than waited out.
 */

import { spawnSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "server.mjs");

// os.homedir() reads USERPROFILE on Windows and HOME elsewhere, and the SQLite factory
// puts the database under it. Both are set so the test never touches a real bus database.
const TEST_HOME = mkdtempSync(join(tmpdir(), "cross-claude-retention-"));
process.env.USERPROFILE = TEST_HOME;
process.env.HOME = TEST_HOME;

const CHANNEL = "retention-check";
const PIN_TEXT = "Standing form every post in this channel follows.";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

const { createDB } = await import("./db.mjs");
const db = await createDB();

try {
  console.log("Starting retention test suite...\n");

  console.log("1. Seed a pinned channel with messages");
  db.setChannelPin(CHANNEL, PIN_TEXT, "peer-a");
  // Plain messages only: a sweep that deletes a parent whose reply is still inside the
  // window is rejected by the self-referencing foreign key on messages.in_reply_to.
  db.sendMessage(CHANNEL, "peer-a", "First report", "message", null);
  db.sendMessage(CHANNEL, "peer-b", "Second report", "message", null);
  assert(db.getMessages(CHANNEL, 10).length === 2, "Two messages in the channel");
  assert(db.getChannelPin(CHANNEL).pinned_text === PIN_TEXT, "Pinned text is stored");

  console.log("\n2. Age the messages past the retention window");
  db.db.prepare(`UPDATE messages SET created_at = datetime('now','-30 days')`).run();
  assert(db.getMessages(CHANNEL, 10).length === 2, "Aged messages are still present");

  console.log("\n3. Run the sweep");
  const sweep = spawnSync("node", [SERVER_PATH, "--cleanup"], {
    encoding: "utf-8",
    env: { ...process.env, USERPROFILE: TEST_HOME, HOME: TEST_HOME },
  });
  console.log(sweep.stdout.trim());
  if (sweep.stderr.trim()) console.log(sweep.stderr.trim());
  assert(sweep.status === 0, "The sweep exits 0");
  assert(/Removed 2 messages/.test(sweep.stdout), "The sweep reports the two messages removed");

  console.log("\n4. Messages are gone, the pinned text is not");
  assert(db.getMessages(CHANNEL, 10).length === 0, "No messages left in the channel");
  const pin = db.getChannelPin(CHANNEL);
  assert(pin?.pinned_text === PIN_TEXT, "Pinned text survived the sweep");
  assert(pin?.pinned_by === "peer-a", "Who set it survived the sweep");
  assert(Boolean(pin?.pinned_at), "When it was set survived the sweep");

  console.log("\n5. Listings carry the flag, never the text");
  const listed = db.listChannelsWithActivity().find(c => c.name === CHANNEL);
  assert(Boolean(listed.has_pin), "The listing says a pinned text exists");
  assert(!("pinned_text" in listed), "The listing carries no pinned text");

  console.log(`\n${passed} passed, ${failed} failed`);
} finally {
  // Windows refuses to delete a database file while a handle is open, so close first and
  // treat a leftover temp directory as untidy rather than as a failed test.
  try { db.db.close(); } catch { /* already closed */ }
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* the OS keeps it */ }
}

process.exit(failed > 0 ? 1 : 0);
