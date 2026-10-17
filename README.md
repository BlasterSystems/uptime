# Uptime Monitoring

Self-hosted service monitoring in **one repository and one Docker image** (an optional
second image adds remote agents): scheduled HTTP/docker probes, push heartbeats,
incidents with alerting, an embedded admin UI, public status pages and Prometheus
metrics — SQLite-first, private by default.

Inspired by [Uptime-Kuma](https://github.com/louislam/uptime-kuma),
[Gatus](https://github.com/TwiN/gatus),
[Rabbit-Company/PulseMonitor](https://github.com/Rabbit-Company/PulseMonitor) and
[Healthchecks](https://github.com/healthchecks/healthchecks) — see
[docs/research/oss-comparison.md](docs/research/oss-comparison.md) for the full analysis.

## Goals

1. **One repository, one image.** Everything ships as a single container
   (`ghcr.io/blastersystems/uptime-monitoring`); the optional agent is the same repo's
   second image. No external database, queue or config service to run.
2. **SQLite-first.** WAL-mode SQLite with encrypted-at-rest secrets is the default
   store; a Postgres dialect is planned (SPEC §14) but never at the cost of the
   zero-config default.
3. **Private by default.** No outbound telemetry, no phone-home, updates are manual.
   The unauthenticated surface is deliberately tiny (health, metrics, push receiver,
   published status pages, rate-limited password recovery).
4. **Ops-honest alerting.** Incidents open after `retries` consecutive failures and
   recover automatically; notifications fan out per monitor routing or channel
   defaults, re-send while down, and every provider has a test button.
5. **Public communication when you want it.** Password-protectable status pages with
   component groups, live incidents, RSS/Atom feeds and badges — visitors can also
   subscribe via those feeds.
6. **Scriptable.** Everything the UI does is an API: session+CSRF or scoped API keys
   (`uk_…`, SHA-256-hashed), push heartbeats with cron expectations, an OpenAPI
   bootstrap script and Prometheus exposition.

## Expectations

- **Shipped (v1):** `http`, `push` and `group` monitors scheduled server-side, plus
  `docker` monitors (unix socket, `tcp://`, TLS); probe engines for `tcp`, `dns`,
  `icmp`, `postgres`, `mysql`, `mssql`, `mongodb` and `redis` (run by the optional
  agent over WS-attempt/HTTP-fallback); auth with Argon2id + TOTP 2FA + recovery
  codes + self-service email recovery (Resend); 8 notification channels (Telegram,
  Discord, Slack, Email/SMTP, Email/Resend, ntfy, Gotify, webhook); incidents,
  maintenance windows, realtime UI (SSE), status pages with manual/auto incidents,
  Prometheus metrics, uptime rollups (hourly/daily), backup/restore, retention,
  export/import and Uptime-Kuma import.
- **Not yet (tracked in SPEC §14):** Postgres dialect, WebSocket hub,
  parent-dependency suppression, `upsideDown` semantics, server-side scheduling of
  the remaining engine types (they validate, store and run via the agent today).
- **Quality bar:** CI gates lint, `vue-tsc`, per-package tests, ≥75 % line coverage,
  the `docker` multi-arch image build, `.agentic/bin/validate` and a docs check;
  Playwright E2E runs auth/monitors/push/incidents/status-page flows against a fresh
  throwaway instance. Documentation is updated in the same change as behavior.

## Design guidelines

The web UI follows the BlasterSystems design system. If you touch `apps/web`, keep
these rules — they are enforced by convention in `apps/web/src/style.css`:

- **Two token layers.** The DS palette (`--paper/--card/--ink/--thread/…`) is mapped
  onto semantic roles (`--bg/--surface/--fg/--accent/--error/--success/…`). Use role
  tokens in components — never raw hex values.
- **One accent.** The vermilion *thread* is the only accent color. Primary buttons
  are ink-filled; vermilion is reserved for error fills/lines and status semantics —
  never a button fill. Error *text* uses `--thread-ink`.
- **Status is shape-first.** ■ up / recorded (square), ◆ down (rotated square),
  ○ pending, striped maintenance — color is secondary to shape everywhere (cards,
  chips, heartbeat strips).
- **Geometry:** 2 px radius on controls, 4 px on panels, hairline borders instead of
  shadows. No drop shadows.
- **Type:** Fira Sans 400/500/600 for UI text, DM Mono 400/500 for values, labels and
  chips; self-hosted in `apps/web/public/fonts` (no font CDN).
- **Themes.** Dark and light are both token-driven; the public status page re-scopes
  the whole palette under `.status-shell[data-theme]` (it renders outside the app
  root) and may override `--accent` with user data (a per-page accent color).
- **Charts are hand-rolled inline SVG** (`apps/web/src/components/charts/`) — no chart
  library; hover labels, strips and markers draw from the same tokens.

## Documentation

| Doc                                                                | Content                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| [docs/SPEC.md](docs/SPEC.md)                                       | **Product & technical specification (source of truth)** |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                       | Architecture overview and component map                 |
| [docs/adr/](docs/adr/)                                             | Architecture decision records                           |
| [docs/DEVELOPMENT_PROCESS.md](docs/DEVELOPMENT_PROCESS.md)         | Contribution process                                    |
| [docs/research/oss-comparison.md](docs/research/oss-comparison.md) | Research notes on the OSS tools that inspired this      |
| [docs/PLAN.md](docs/PLAN.md)                                       | Implementation roadmap (M0–M6)                          |

Developer integration docs (API auth, push heartbeats, SSE, Prometheus, badges,
automation) are served by the app itself under **`/docs`**.

## Development

Requires Node.js 24 and pnpm 10 (corepack).

```bash
pnpm install
pnpm build        # core → db → notify → agent → server, then web
pnpm test         # vitest in every package (server, packages and web unit tests)
pnpm test:e2e     # Playwright: builds, boots a throwaway server, drives Chromium (e2e/)
pnpm coverage     # + coverage gate (≥75% lines per package; web baseline gate)
pnpm dev          # server on :3001 (SQLite in ./data)
pnpm --filter @uptime/web dev   # Vite dev server with /api proxied to :3001
UPTIME_AGENT_TOKEN=... node apps/server/dist/main.js agent   # agent role
docker compose up --build       # full stack
```

Test pyramid: unit tests live next to the sources (`*.test.ts`; web uses vitest +
jsdom + `@vue/test-utils`), server API tests are in-process supertest suites, and
`e2e/` runs Playwright flows (auth, monitor create incl. the retries/interval
regression, push heartbeats, incidents, status pages, channels) against a fresh
throwaway instance.

Secrets policy: never commit real keys, tokens, `.env` files or instance databases.
Only `deploy/.env.example` (placeholders) is tracked; generate `ENCRYPTION_KEY` with
`openssl rand -hex 32`.

## Deployment

Compose-first; TLS is delegated to the reverse proxy in front of the container.

```yaml
services:
  uptime-monitoring:
    image: ghcr.io/blastersystems/uptime-monitoring:latest
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
    image: ghcr.io/blastersystems/uptime-agent:latest
    environment:
      - UPTIME_SERVER_URL=http://uptime-monitoring:3001
      - UPTIME_AGENT_TOKEN=${UPTIME_AGENT_TOKEN}
    restart: unless-stopped
```

`deploy/.env.example` documents the environment variables used by the compose
deployment (port, seed flag, encryption key, agent token, `DOCKER_GID` for docker
monitors). Releases are published from `v*` tags via
`.github/workflows/release.yml`; `dev-*` tags deploy to the development VM.

## License

[MIT](LICENSE) — © BlasterSystems
