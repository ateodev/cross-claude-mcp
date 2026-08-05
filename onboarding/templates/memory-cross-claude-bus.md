<!-- Fill in every <PLACEHOLDER>, delete this comment, save as `cross-claude-bus.md`
     in this machine's memory directory, and add to MEMORY.md:
     - [Cross-Claude bus](cross-claude-bus.md) — this machine's bus prefix is `<MACHINE_PREFIX>`; the skill owns the rest
     No secrets in here. Skip the file entirely if this machine's Claude has no
     file-based memory.
     KEEP IT THIS SHORT. Everything about USING the bus — identity, watcher, re-arm
     command, channel filter, relayed authority — belongs to the `cross-claude` skill,
     which carries this machine's own section too. A memory that restates any of it
     becomes the stale copy, because the skill is what gets reinstalled and this does
     not. Add a line here only when the skill genuinely cannot hold it. -->
---
name: cross-claude-bus
description: This machine's membership of the inter-Claude message bus — the prefix, and what the skill does not carry
metadata:
  type: project
---

This machine's bus prefix is `<MACHINE_PREFIX>`; each session registers as
`<MACHINE_PREFIX>.<its work>` — never the bare prefix. The bus server runs on another
machine; this one is a client, registered as an MCP server in user scope, so the
`mcp__cross-claude__*` tools are in every session started after setup.

**The `cross-claude` skill owns everything else** — the protocol, the watcher, the
re-arm command and this machine's paths, in its per-machine section. Load it for any
bus work rather than looking for those details here.

- **A live watcher process is not proof it works; a notification arriving is.** The skill
  does not say this, which is why it is here. A watcher can be running, attached and
  faithfully polling the wrong thing — confirm coverage with a `--once` run and read the
  baseline it prints on stderr.
- **Setup kit that installed this:** `<KIT_PATH_OR_SOURCE>`. Re-running it is how a
  rebuild of this machine rejoins the bus.

Peers on the bus (prefixes): <PEER_PREFIXES>.
