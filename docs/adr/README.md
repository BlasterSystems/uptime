# Architecture Decision Records

Read this index before loading individual ADRs. Load only records relevant to the current scope, component, tag, or question.

## Lifecycle

Valid statuses are `Proposed`, `Accepted`, `Rejected`, `Deprecated`, and `Superseded`.

Accepted records are historical. Create a new ADR to replace a decision, mark the old record `Superseded`, and link both records.

## Index

| ADR | Status | Scope | Tags | Summary | Supersedes |
|---|---|---|---|---|---|
| [ADR-0001](0001-single-repo-typescript-monorepo.md) | Accepted | Repository topology, runtime language, server framework, UI stack | architecture, monorepo, typescript, express, vue | One pnpm/TypeScript workspace; Node.js 24, Express 5, Vue 3 + Vite; shared types in `packages/core`, storage in `packages/db` | None |
| [ADR-0002](0002-sqlite-first-storage-secrets-encryption.md) | Accepted | Persistence engines, schema tooling, retention, secrets at rest | storage, sqlite, postgres, encryption, security | SQLite (WAL) default under `/data/uptime.db`; PostgreSQL via `DATABASE_URL` with the same Drizzle schema; AES-256-GCM secrets with `ENCRYPTION_KEY` | None |
| [ADR-0003](0003-agentless-core-optional-agents.md) | Accepted | Check execution topology and vantage points | architecture, agent, scheduling, push | In-process scheduler and checks by default; always-on push receivers; optional agent image (M5) over WebSocket with retry queue + ack and HTTP fallback | None |
| [ADR-0004](0004-docker-first-packaging.md) | Accepted | Container packaging, CI release pipeline, TLS boundary, configuration precedence | docker, ci, packaging, deployment | One Dockerfile with server/agent roles; compose happy path with bind-mounted `/data`; non-root, read-only compatible; buildx multi-arch to GHCR with SBOM; DB > env > defaults | None |

## When an ADR is required

Use an ADR for durable, cross-cutting, security-sensitive, data, deployment, foundational dependency, or external integration decisions. Routine refactors and local implementation details normally do not require one.

Copy `template.md` to `NNNN-short-title.md`, choose the next unused four-digit number, and update this index.
