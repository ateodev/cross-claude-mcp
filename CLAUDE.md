# Cross-Claude MCP

**Project type**: Personal open-source project — Simple Mode always on.

## Architecture: Dual-Repo Model

**Public (open-source)**: This repo (`rblank9/cross-claude-mcp`) — MIT licensed
- `server.mjs` — Entry point (stdio + HTTP modes)
- `db.mjs` — SQLite (local) / PostgreSQL (remote) abstraction
- `tools.mjs` — Shared MCP tool + prompt registration (used by both repos)
- `skill/SKILL.md` — Superpowers skill for Claude Code (symlink to `~/.claude/skills/cross-claude/`)
- `test.mjs` — Integration tests (54 tests)

**Private (SaaS)**: `rblank9/cross-claude-mcp-saas` at `/Users/rblank/Projects/cross-claude-mcp-saas/`
- Flat structure (no saas/ subdirectory), standalone deployable
- `server-saas.mjs`, `db-saas.mjs`, `auth.mjs`, `billing.mjs`, `dashboard.mjs`, `admin.mjs`, `rate-limit.mjs`
- `tools.mjs` — Imported from this repo as a GitHub package dependency (NOT a local copy)

## Development Workflow

- **Source of truth for SaaS code**: `saas/` directory in THIS repo
- **Deployment**: SaaS repo imports `tools.mjs` as a GitHub package (`"cross-claude-mcp": "github:rblank9/cross-claude-mcp"`). To propagate tools.mjs changes: push here, then `npm update cross-claude-mcp` in the SaaS repo and redeploy.
- **Railway SaaS** deploys from the private repo via Procfile (`web: node server-saas.mjs`)
- **Railway open-source** deploys from this repo's `main` branch

## Key Rules

- NEVER put SaaS-only code (auth, billing, admin, multi-tenancy) into `server.mjs` or `db.mjs`
- `tools.mjs` is the ONE shared file — SaaS imports it as a package; after changes, run `npm update` in SaaS repo
- The SaaS DB schema has `tenant_id` on all tables with ON DELETE CASCADE — open-source schema does not
- Procfile controls Railway entry point — not `npm start`
- Stripe webhook route MUST use `express.raw()` BEFORE any `express.json()` middleware
