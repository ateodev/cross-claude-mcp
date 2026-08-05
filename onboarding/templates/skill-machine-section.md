<!-- Fill in every <PLACEHOLDER>, delete this comment, then append the rest to the
     INSTALLED skill copy (~/.claude/skills/cross-claude/SKILL.md) — below the shared
     part, which stays byte-identical on every machine. No secrets in here, and no
     full instance id: the id is per-session, only the prefix belongs to the machine. -->

## This machine (bus prefix `<MACHINE_PREFIX>`)

- Watcher script: `<KIT_HOME>/bus-watch.<ext>`, run with `<INTERPRETER_PATH>`
  <!-- say so explicitly if the interpreter is not on PATH -->
- It needs no configuration: the bus URL and token come from this machine's
  cross-claude MCP registration. Pass your own instance id on argv, since it differs
  per session.
- Test: `<INTERPRETER_PATH> <KIT_HOME>/bus-watch.<ext> --once --instance <your id>`
  → `bus-watch armed …` line on stderr, exit 0.
- Re-arm: check for an already-running watcher first — `<PROCESS_CHECK_COMMAND>`, since
  `TaskList` does not reliably list Monitors — then
  `Monitor(persistent:true, command:'<INTERPRETER_PATH> <KIT_HOME>/bus-watch.<ext> --instance <your id>')`.
  <!-- Fill this to match a permission allow rule this machine actually has, not just a
       command that runs. If the rule names a launcher script, the launcher IS the
       command. A watcher started under a permissive session mode but outside the
       allow-list silently fails to arm under a stricter one, and an unarmed watcher
       looks exactly like a quiet bus. -->
- Permission rule covering that command: `<ALLOW_RULE>`
