# Uptime Monitoring — project README

Single-repository, Docker-first, self-hosted health monitoring for services, containers
and databases — with an embedded UI, alerting and status pages. Inspired by
[Uptime-Kuma](https://github.com/louislam/uptime-kuma), [Gatus](https://github.com/TwiN/gatus),
[Rabbit-Company/PulseMonitor](https://github.com/Rabbit-Company/PulseMonitor) and
[Healthchecks](https://github.com/healthchecks/healthchecks).

## Why

Existing tools force a trade-off: Uptime-Kuma is a single image but agentless-only;
Gatus is config-file-first; PulseMonitor has a great agent/server split but is spread
across three repositories with a ClickHouse dependency. This project is **one
repository, one (optionally two) Docker images, SQLite by default** — with an optional
push/agent mode borrowed from the best parts of the above.

## Documentation

| Doc                                                                | Content                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| [docs/SPEC.md](docs/SPEC.md)                                       | **Product & technical specification (source of truth)** |
| [docs/research/oss-comparison.md](docs/research/oss-comparison.md) | Research notes on the OSS tools that inspired this      |
| [docs/PLAN.md](docs/PLAN.md)                                       | Implementation roadmap (M0–M6)                          |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                       | Architecture overview and component map                 |
| [docs/adr/](docs/adr/)                                             | Architecture decision records                           |
| [docs/DEVELOPMENT_PROCESS.md](docs/DEVELOPMENT_PROCESS.md)         | Process (from agentic-bootstrap scaffold)               |

## Status

**v1 feature-complete per SPEC.md**: all monitor types (http, push, tcp, dns, icmp,
postgres, mysql, mssql, mongodb, redis, docker), groups with notification suppression,
auth (Argon2id + TOTP 2FA + scoped API keys), 7 notification providers, incidents,
realtime UI (SSE), status pages, maintenance windows, Prometheus metrics, uptime API
from rollups, the optional agent image (HTTP-fallback transport; WS hub follow-up),
export/import, backups, retention and Kuma import. Governance scaffold by
[agentic-bootstrap](https://github.com/…/agentic-bootstrap) (`--platform all`).

Test coverage is gated at ≥75% lines per package in CI.

## Development

Requires Node.js 24 and pnpm 10 (corepack).

```bash
pnpm install
pnpm build        # core → db → notify → agent → server, then web
pnpm test         # vitest in every package
pnpm coverage     # + 75% coverage gate
pnpm dev          # server on :3001 (SQLite in ./data)
pnpm --filter @uptime/web dev   # Vite dev server with /api proxied to :3001
UPTIME_AGENT_TOKEN=... node apps/server/dist/main.js agent   # agent role
docker compose up --build       # full stack
```

The agent role connects to a running server (`UPTIME_SERVER_URL` +
`UPTIME_AGENT_TOKEN`); see `docker-compose.yml` for the server and
`.github/workflows/release.yml` for the multi-arch publish.

## Quick deployment target (end state, M5)

```yaml
services:
  uptime-monitoring:
    image: ghcr.io/<org>/uptime-monitoring:latest
    ports: ['3001:3001']
    environment:
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
    volumes:
      - ./data:/data
    restart: unless-stopped
```

Optional remote agent (same repository, second image):

```yaml
services:
  uptime-agent:
    image: ghcr.io/<org>/uptime-agent:latest
    environment:
      - UPTIME_SERVER_URL=http://uptime-monitoring:3001
      - UPTIME_AGENT_TOKEN=${UPTIME_AGENT_TOKEN}
    restart: unless-stopped
```
