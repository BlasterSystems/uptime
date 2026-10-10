# OSS monitoring tools — research notes

Sources inspected on 2026-10-10 (GitHub API + READMEs; stars/licenses as of that date).

## Comparison

| Tool                                                                                                                                                | Stack                                                   | License        | Storage                 | Agent model                                                                                                                                   | UI                                                                                  | Port                    | Notable strengths                                                                                                                                                                                                                         | Pain points                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [Uptime-Kuma](https://github.com/louislam/uptime-kuma) 92k★                                                                                         | Node.js (better-sqlite3, socket.io, express, knex, Vue) | MIT            | SQLite (single file)    | **Agentless** + push heartbeats                                                                                                               | Embedded SPA, socket.io live updates                                                | 3001                    | Best-in-class UX; 90+ notification integrations; docker container monitor; cert expiry; maintenance windows; tags; 2FA; prometheus `/metrics`; API keys; status pages                                                                     | Monolith checks block on heavy monitors historically; no remote agents (all checks from server vantage); single-user-ish auth model |
| [Gatus](https://github.com/TwiN/gatus) 12k★                                                                                                         | Go                                                      | Apache-2.0     | SQLite / Postgres / …   | Agentless (config-as-code)                                                                                                                    | Embedded, lean                                                                      | 8080                    | **Config-as-code (YAML)**, expected-body/keyword checks, health-check **dependencies between endpoints**, remote instances, prometheus alerts, auto-discovery (k8s/docker providers)                                                      | Config-file-first UX; UI is secondary; no native DB query monitors (TCP/ICMP level for DBs)                                         |
| [PulseMonitor](https://github.com/Rabbit-Company/PulseMonitor) + [UptimeMonitor-Server](https://github.com/Rabbit-Company/UptimeMonitor-Server) 68★ | Rust agent + TypeScript(Bun) server                     | GPL-3.0 (both) | **ClickHouse** (server) | **First-class agent/server split** — server pushes monitor configs to agents over WS; agents pulse back with retry queue + ack; HTTP fallback | External configurator (uptime-monitor.org/configurator) + separate status page repo | 3000                    | **PostgreSQL/MySQL/MSSQL/Redis monitors with real queries (SELECT 1 / PING)**; pulse template variables (`{latency}`); groups with any-up/all-up/percentage strategies; **dependency-based notification suppression**; admin API for CRUD | 3 repositories; ClickHouse ops burden; young project; agent useless standalone (no local UI); GPL-3.0                               |
| [Healthchecks](https://github.com/healthchecks/healthchecks) 10k★                                                                                   | Python/Django                                           | BSD-3-Clause   | Postgres/MySQL          | **Push/dead-man's-switch only** (services ping it)                                                                                            | Django templates                                                                    | 8000                    | The cron-monitoring gold standard: grace periods, `/fail` + `/start` pings, log capture on ping, 20+ integrations                                                                                                                         | No active probing of your infra (it waits to be pinged); not an all-round uptime tool                                               |
| [Beszel](https://github.com/henrygd/beszel) 26k★                                                                                                    | Go + PocketBase                                         | MIT            | PocketBase (SQLite)     | **SSH-installed agent** streaming metrics                                                                                                     | Embedded hub UI                                                                     | 8090 (hub) / agent none | 1-binary agent, docker stats per container, alerts, very light                                                                                                                                                                            | **Metrics** (CPU/RAM/disk/net) not endpoint health — complementary to this project, not a competitor                                |

Others considered and excluded for v1 inspiration depth: Statping-ng (unmaintained),
Zabbix/Nagios/Icinga (heavyweight, wrong category), Netdata (per-node metrics agent,
different problem), Grafana+Prometheus (build-vs-buy: we want a single container).

## What we take from each

### From Uptime-Kuma — the deployment & UX baseline

- **One container, SQLite file volume, embedded SPA** — the entire product runs with
  `docker run -v ./data:/data -p 3001:3001`. This is the deployment model users expect.
- `better-sqlite3` + WAL is proven at Kuma's scale; a second dialect (Postgres) is a
  config switch, not a fork (Kuma proves knex works; we prefer Drizzle for TS types).
- Feature checklist to reach parity on: maintenance windows, tag filtering, cert-expiry
  warnings, push heartbeats with grace period, API keys with scopes, prometheus
  `/metrics`, import/export, 2FA.
- socket.io-style live updates: heartbeat events pushed to the UI without polling.

### From Gatus — the power-user layer

- **Expected conditions as first-class** (status ranges, keyword in body, response-time
  caps, cert-expiry thresholds) instead of fixed check kinds.
- **Endpoint dependencies** for alert suppression — Gatus does this between endpoints;
  PulseMonitor does it between monitors/groups. We adopt the monitor→monitor version.
- Config-as-code: optional import/export (TOML/JSON) and an env-driven bootstrap so the
  stack is reproducible — but the **UI stays the primary** editor (Kuma lesson).
- Prometheus `/metrics` from day one.

### From PulseMonitor + UptimeMonitor-Server — the agent model (and what we avoid)

- The agent/server WS protocol with **retry queue + ack** (no lost pulses) and HTTP
  fallback is solid; we keep the concept for the optional agent.
- **Database monitors with real queries** (PostgreSQL `SELECT 1`, Redis `PING`) —
  not just TCP. We add these as first-class monitor types in the same single repo.
- Group strategies: `any-up`, `all-up`, `percentage: N%`.
- **What we avoid**: the 3-repo split (agent / server / status page) and ClickHouse —
  a single repo with SQLite default + optional agent image covers the 95% case; a
  time-series DB is a phase-3 concern behind an interface.

### From Healthchecks — the push model details

- Grace periods + `/start` + `/fail` endpoints, last-ping log capture (attach stderr of
  a cron job) — our push monitor type adopts the URL shape:
  `/api/v1/push/<token>(/start|/fail)`.
- Cron-expression schedules for jobs that must run _at_ a time, not just every N sec.

### From Beszel — later phases

- SSH-based one-line agent install and per-docker-container stats; a `metrics` monitor
  family (phase 3) rather than v1 scope.

## Verdict informing the spec

1. **Deployment model**: Uptime-Kuma's (single image, SQLite volume, embedded UI).
2. **Feature depth for checks**: Gatus-style expected-conditions + PulseMonitor-style
   database monitors.
3. **Agents**: agentless by default (Kuma/Gatus), **optional** push/agent image
   (PulseMonitor/Healthchecks) in the same repo — two images from one Dockerfile via a
   subcommand entrypoint.
4. **Repo**: one repository, TypeScript, monorepo workspace (`server` / `web` / `agent` /
   shared `core`+`db` packages). Rationale and rejected alternatives in
   [ADR-0001](../adr/0001-single-repo-typescript-monorepo.md).
5. **License**: MIT (permissive, like Kuma/Beszel; avoids GPL contagion).
6. **OpenAPI**: none of the five supports importing an OpenAPI document to generate
   monitors. The server should expose an admin API so a script can generate HTTP
   monitors from `openapi.yaml` paths — spec'd in SPEC.md §9.
