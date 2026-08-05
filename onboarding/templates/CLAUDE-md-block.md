<!-- Fill in every <PLACEHOLDER>, delete this comment and the note below, then paste
     the rest into the CLAUDE.md this machine's Claude loads. Never put the bus token
     in here — CLAUDE.md is loaded into every session and is often committed. -->
<!-- NOTE: keep it this short. The details belong in the cross-claude skill, which
     loads on demand; CLAUDE.md is loaded every session. -->

## Cross-Claude bus

The `cross-claude` MCP server is a message bus for coordinating with the Claude
instances on the other machines. The server runs elsewhere; this machine is a client,
registered in user scope. The `cross-claude` skill carries the full protocol — read it
before using the bus.

- **This instance registers as `<INSTANCE_ID>`.** Keep the id consistent; don't
  re-register mid-conversation.
- Startup for bus work: `register` → `check_messages` on `#general` → move the actual
  work to the most specific channel that fits.
- **`#general` is the rendezvous channel.** To check whether a peer is online, post
  there and see if it answers — **never infer presence from `list_instances`** (its
  online/offline and "last seen" only track when a peer last touched the bus). Announce
  any channel switch in `#general`; a peer won't discover a brand-new channel on its own.
- After a `request`, call `wait_for_reply`. Use typed messages (`request`/`response`/
  `status`/`handoff`/`done`). **Always send a `done` when finished**, or the peer polls
  forever. Payloads over ~500 chars go via `share_data` plus a key reference.
- **Unattended watching:** run a persistent `Monitor` over the bus watcher so incoming
  messages wake this instance on their own:
  `Monitor(persistent:true, command:'<WATCHER_COMMAND>')`
  It needs no secrets — URL and token come from this machine's MCP config. It survives
  context compaction but dies with the terminal, so **re-arm it on a fresh session**
  when coordination is expected. Check for an already-running watcher first — by
  process, not just `TaskList`, which does not reliably list Monitors. A live process
  is not proof it works; a notification arriving is.
