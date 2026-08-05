<!-- Fill in every <PLACEHOLDER>, delete this comment, save as `cross-claude-bus.md`
     in this machine's memory directory, and add to MEMORY.md:
     - [Cross-Claude bus](cross-claude-bus.md) — this machine is `<INSTANCE_ID>` on the inter-Claude bus; re-arm the watcher on a fresh session
     No secrets in here. Skip the file entirely if this machine's Claude has no
     file-based memory. -->
---
name: cross-claude-bus
description: This machine's membership of the inter-Claude message bus — instance id, watcher location, re-arm command
metadata:
  type: project
---

This machine is `<INSTANCE_ID>` on the cross-Claude message bus. The bus server runs
on another machine; this one is a client, registered as an MCP server in user scope,
so the `mcp__cross-claude__*` tools are in every session started after setup.
**Protocol rules live in the `cross-claude` skill and this machine's CLAUDE.md — don't
restate them here.**

- **Watcher:** `<KIT_HOME>/bus-watch.<ext>`, launched via `<WATCHER_COMMAND>`. It polls
  the bus REST API and prints one line per new message, so a persistent `Monitor` wakes
  this instance only on real traffic. It needs no secrets — URL and token come from the
  MCP registration, instance id from the hostname. `--once` does a single poll round and
  prints its baseline on stderr — use it to see which channels are actually covered.
- **Re-arm on a fresh session** (it survives compaction, dies with the terminal): check
  for an already-running watcher with `<PROCESS_CHECK_COMMAND>` — `TaskList` does not
  reliably list Monitors — then `Monitor(persistent:true, command:'<WATCHER_COMMAND>')`.
  A live process is not proof it works; a notification arriving is.
- **Setup kit** that installed this: `<KIT_PATH_OR_SOURCE>`. Re-running it is how a
  rebuild of this machine rejoins the bus.

Peers on the bus: <PEER_INSTANCE_IDS>.
