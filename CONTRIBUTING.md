# Contributing to Uptime

Thanks for the interest. This project follows one rule above all:
**behavior changes ship with tests and docs in the same change.**

## Prerequisites

- Node.js 24 and pnpm 10 (`corepack enable`).
- Docker (optional, for the container build; `docker compose up --build` runs
  the full stack locally).

## Setup

```bash
pnpm install
pnpm build          # core → db → notify → agent → server, then web
pnpm dev            # server on :3001, SQLite in ./data
```

`pnpm dev` with a fresh `./data` seeds one example HTTP monitor and walks you
through first-run admin setup in the UI.

## Where things live

| Path | What |
| --- | --- |
| `apps/server` | Express 5 REST API, scheduler, notifier, push receiver, agent control plane |
| `apps/web` | Vue 3 + Vite SPA (BlasterSystems design system; see `README.md` §Design guidelines) |
| `packages/core` | Check engine, per-type config schemas (the single validation source of truth) |
| `packages/db` | Drizzle schema + migrations (SQLite) |
| `packages/notify` | Notification providers |
| `packages/agent` | Optional remote agent (WS attempt + HTTP fallback) |
| `docs/SPEC.md` | Product & technical spec — the source of truth, including §14 (implemented deviations) |

Read `docs/DEVELOPMENT_PROCESS.md` before a first contribution; it describes
the workflow, validation gates and when an ADR
(`docs/adr/README.md`) is required.

## Validation

```bash
pnpm lint
pnpm typecheck
pnpm test            # unit + in-process API tests
pnpm coverage        # >= 75% lines per package (gated)
pnpm test:e2e        # Playwright against a throwaway instance
pnpm --filter @uptime/web typecheck   # vue-tsc (not covered by pnpm build)
.agentic/bin/validate
.agentic/bin/docs-check
```

CI runs all of the above plus a multi-arch image build. Please run at least
`pnpm test` and `pnpm --filter @uptime/web typecheck` locally when you touched
the web app — `pnpm build` alone does not typecheck it.

## Pull requests

- Conventional Commits subjects (`feat:`, `fix:`, `chore:`, `docs:`, `test:`,
  `ci:`). One logical change per PR.
- Update `CHANGELOG.md` under *Unreleased* for user-visible changes.
- Update docs (README / SPEC / in-app `/docs`) in the same PR as the behavior.
- Keep the history linear: PRs are squash- or rebase-merged, no merge commits.
- Never commit real secrets, `.env` files or instance databases. Only
  `deploy/.env.example` (placeholders) is tracked.

## Issues

Please use the issue templates. For security-sensitive reports use
[private vulnerability reporting](SECURITY.md) instead of a public issue.

## License

By contributing you agree that your contributions are licensed under the
[Apache License, Version 2.0](LICENSE).
