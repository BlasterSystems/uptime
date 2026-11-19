# Agent setup

How the AI-agent tooling in this repository is wired, validated, and
operated. Two independent layers coexist: **agentic-bootstrap** owns the
instruction canon, **refract** owns workflow skills, validators, and hooks.
Neither replaces the other.

## Instruction entry points

| Platform | Entry point | Skills | Invoke |
|---|---|---|---|
| Claude Code | `CLAUDE.md` → `AGENTS.md` | `.claude/skills/` | `/name` |
| omp | `AGENTS.md` + `.omp/RULES.md` | `.agents/skills/` | `/skill:name` |
| Codex / OpenCode | `AGENTS.md` | `.agents/skills/` | `$name` / `/name` |

`AGENTS.md` (agentic-bootstrap) is the canon; it points at
`.agentic/bin/validate` and `.agentic/bin/docs-check`. The refract skill set
(`research`, `confidence-check`, `implement`, `security-check`,
`quality-review`, `commit`, `deploy-dev`, `deploy-prd`, `hotfix`,
`refract`) is additive and optional per task.

## Validation layers

| Command | Owner | Where it runs |
|---|---|---|
| `.agentic/bin/validate`, `.agentic/bin/docs-check` | agentic-bootstrap | CI `check` job, pre-commit hook |
| `.refract/bin/validate` | refract | pre-commit hook, `docs-check` workflow |
| `.refract/bin/agent-check` | refract | omp `agent_end` hook, Claude Stop hook (every agent turn) |
| `.refract/bin/deploy-ready` | refract | gate before any deploy skill merges/tags/pushes |

The pinned pre-commit hook (`.git/hooks/pre-commit`, installed by
`setup-hooks.sh`) hash-verifies its scripts, runs `.refract/bin/validate`,
optional gitleaks, `.refract/bin/docs-check`, then the configured `pnpm
test` and `pnpm build`. After changing refract-generated scripts, re-run
`./setup-hooks.sh` to re-pin.

## MCP servers

- `.mcp.json` — **serena** (project-scoped code intelligence). Claude Code
  and omp both read this file.
- `.omp/mcp.json` — **context7** (omp only). Adding servers here is a
  project decision; generated-file edits are reported as drift by future
  `refract retrofit` runs.

## Deployment

`docs/DEPLOYMENT.md` is the configured policy (Status: CONFIGURED); the
deploy skills refuse to act while `.refract/bin/deploy-ready` fails. A
`prd-*` tag publishes dated GHCR image tags only — `v*` releases stay
governed by `docs/RELEASING.md`.

## Maintenance

Refract is applied agent-guided: preview with `--dry-run --plan-format
json`, report the plan identifier, apply in a trusted terminal with
`--expected-plan`. Customized files (`docs/DEPLOYMENT.md`, this file,
`AGENTS.md`, kept skills) are preserved; the plan reports when the template
changed underneath them. See `refract` README → "Upgrade a managed
project" and the skill named `refract`.
