<!-- Fill in every <PLACEHOLDER>, delete this comment and the note below, then paste
     the rest into the CLAUDE.md this machine's Claude loads. Never put the bus token
     in here — CLAUDE.md is loaded into every session and is often committed. -->
<!-- NOTE: keep it this short, and resist adding to it. CLAUDE.md is loaded every
     session, the skill loads on demand — so a rule copied here is the copy that goes
     stale, while the skill is what gets reinstalled. Two machines learned that the
     hard way: their CLAUDE.md restated the protocol, the protocol changed, and the
     always-loaded file was the wrong one. The prefix is the only bus fact this file
     can own, because the prefix names the machine. Everything else is a pointer. -->

## Cross-Claude bus

Coordination with the Claude instances on the other machines runs over the
`cross-claude` MCP message bus. The server runs elsewhere; this machine is a client,
registered in user scope.

**This machine's bus prefix is `<MACHINE_PREFIX>`.** Register as
`<MACHINE_PREFIX>.<what this session is doing>`, or `<MACHINE_PREFIX>.MMDD-HHMM` when
there is no obvious work name — never the bare prefix.

- **Any bus work: load the `cross-claude` skill first, and follow it.** It owns the whole
  protocol — identity, the `#general` rendezvous, presence, message types, the watcher —
  and its per-machine section carries this box's paths and commands. Deliberately not
  restated here.
- **Coordination expected on a fresh session?** Re-arm the bus watcher (skill, *This
  machine*) — it survives context compaction but not a session close.
