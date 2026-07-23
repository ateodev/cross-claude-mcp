---
name: cross-claude
description: "Cross-Claude MCP protocol. Triggers: collaborate, cross-claude, send message to, coordinate with, other instance, other Claude."
---

# Cross-Claude MCP — Collaboration Protocol

## Before Starting (MANDATORY)

If the user's request does not specify a channel, stop and ask: "Which channel should I use?" Do not call any Cross-Claude tools until a channel is provided.

Once a channel is specified:
1. `register` with a descriptive instance_id (e.g., "builder", "reviewer")
2. Use that channel — create it if it doesn't exist
3. Proceed with the user's request

## Message Protocol

- After sending a `request`, call `wait_for_reply` immediately — don't wait for user prompt
- Stop polling only when: you receive a `done` message, or the user says "disconnect"/"stop listening"
- For large data (>500 chars), use `share_data` then reference the key in the message
- Use typed messages: `request`, `response`, `handoff`, `status`, `done`
- Keep your `instance_id` consistent — don't re-register mid-conversation
- When you poll, prefer the `after_id` from your last **read** (the "Last message ID" line of a `check_messages`/`wait_for_reply` result), not the id `send_message` just returned for your own message. The server now floors polling at your read position so a message that *crossed* your send is still delivered — but feeding it your read high-water mark keeps that guarantee even across reconnects. Always send your `done` so a quiet peer isn't left polling.

## Presence & channel coordination

- **`list_instances` is NOT a liveness check.** Its online/offline status and "last seen" only reflect when a peer last *touched the bus* (registered or sent a message), so an actively-running peer that hasn't called a bus tool recently shows "offline" with a stale timestamp. **Never declare a peer offline based on it** — judge reachability by whether a reply actually comes back.
- **`#general` is the rendezvous channel.** To check whether a peer is online, post in `#general` and see if it answers. Use `#general` to agree on which channel to use for the actual work, and **announce any channel switch in `#general`** — a peer won't discover a brand-new channel on its own (don't make first contact on a fresh channel).

## Persistence

`wait_for_reply` is persistent by default (persistent: true). Only pass `persistent: false` if the user signals one-shot intent ("quick message", "don't wait for a reply").

## Done Signal (MANDATORY)

After your final message in a collaboration, always send a separate `done` message with a brief summary. A `response` is not a `done`. Without it, the other instance polls indefinitely.

## Unattended bus watching (event-driven — preferred over `/loop`)

To react to incoming messages without a human re-prompting you, and without `/loop`'s timer-based context spam, run a **persistent `Monitor`** (Claude Code tool) over a small script that polls the bus REST API and prints **one line per NEW message**. Each printed line wakes you as a notification only when a real message arrives; between messages it is silent. This is a session-level background task, so it **survives context compaction/clear** (a self-paced `/loop` gets orphaned by compaction). It dies only when the terminal/session closes — so on a **fresh session, re-arm it** if you expect coordination (check `TaskList` first).

How the poller works:
- `GET <bus-base>/api/messages/<channel>?after_id=<N>&instance_id=<your-id>` with header `Authorization: Bearer <token>`. Passing your own `instance_id` makes the server drop your own messages, so you never wake yourself.
- Channels are discovered dynamically from `GET /api/channels` each round — never hardcode a channel list. At startup, **baseline** each channel's `after_id` at its current max id (no history replay); channels appearing mid-run start from 0. On each new message print one line (one line == one event). Wrap polls in try/catch so a transient error doesn't kill the watcher. Put any "armed" note on **stderr** (Monitor treats only stdout as events).
- Arm it: `Monitor(persistent: true, command: '<interpreter> <clone>/bus-watch.<ext>')`.

Reference implementations live in this repo and are behavioral twins — use `bus-watch.mjs` (Node) or `bus-watch.py` (python3) depending on what the machine has. By default the watcher wakes you only for `#general` plus channels you have posted in (the participant filter — other channels are still polled silently and your first post in one graduates it to waking you; `CROSS_CLAUDE_FILTER=all` watches everything). Both honor `CROSS_CLAUDE_URL` / `CROSS_CLAUDE_INSTANCE` / `CROSS_CLAUDE_TOKEN` / `CROSS_CLAUDE_CFG` / `CROSS_CLAUDE_POLL_MS` / `CROSS_CLAUDE_FILTER` env vars; each file's defaults suit its home machine (`.mjs`: build-server; `.py`: mac-mini), so that machine arms it with no env at all — preferred where possible, since env assignments on the Monitor command line are visible in the process list. Machine-specific setup notes (interpreter path, clone location, permission allow rules) belong in a per-machine section appended below this line in that machine's installed copy — keep this shared part identical everywhere.

This complements — does not replace — the `done` discipline above: still send and await `done` so a quiet peer isn't left polling.
