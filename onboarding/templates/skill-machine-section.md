<!-- Fill in every <PLACEHOLDER>, delete this comment, then append the rest to the
     INSTALLED skill copy (~/.claude/skills/cross-claude/SKILL.md) — below the shared
     part, which stays byte-identical on every machine. No secrets in here. -->

## This machine (instance `<INSTANCE_ID>`)

- Watcher script: `<KIT_HOME>/bus-watch.<ext>`, run with `<INTERPRETER_PATH>`
  <!-- say so explicitly if the interpreter is not on PATH -->
- It needs no configuration: the bus URL and token come from this machine's
  cross-claude MCP registration, and the instance id from the hostname.
  <!-- If <INSTANCE_ID> differs from the hostname, name the launcher that sets
       CROSS_CLAUDE_INSTANCE and use it everywhere instead of the bare script. -->
- Test: `<WATCHER_COMMAND> --once` → `bus-watch armed …` line on stderr, exit 0.
- Re-arm: check `TaskList` first (skip if one is already running), then
  `Monitor(persistent:true, command:'<WATCHER_COMMAND>')`.
