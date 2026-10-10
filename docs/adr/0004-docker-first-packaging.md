# ADR-0004: Docker-first packaging — one image, two roles, compose default

- **Status**: Accepted
- **Date**: 2026-10-10

## Context

The audience runs Docker on single VMs (our case: Proxmox LXCs, compose, existing
reverse proxy). Competitors set expectations: Uptime-Kuma = one image + volume;
Gatus = one binary; PulseMonitor = three repos. CI must produce multi-arch images.

## Decision

1. **One Dockerfile** producing a `server` image (default) and an `agent` variant
   (entrypoint subcommand dispatch, ADR-0003). `docker compose up` is the documented
   happy path: bind-mounted `/data`, `PORT=3001`, `restart: unless-stopped`, healthcheck.
2. **Non-root** runtime (UID 1001), `read_only: true` compatible (tmpfs `/tmp`), no
   shell in the final stage.
3. **TLS is delegated** to the user's reverse proxy (documented Nginx Proxy Manager /
   Caddy / Traefik examples); the container speaks plain HTTP internally.
4. **CI**: GitHub Actions — lint/typecheck/unit/integration/e2e on PRs; on `v*` tags:
   buildx `linux/amd64,linux/arm64` → GHCR (`latest` + semver) with SBOM; semantic
   versioning per agentic-bootstrap RELEASING conventions.
5. **Configuration precedence**: DB (UI-edited) > env (`PORT`, `DATA_DIR`,
   `DATABASE_URL`, `ENCRYPTION_KEY`) > built-in defaults. Optional file import/export
   for reproducibility (SPEC §5) — file is never the live source of truth.

## Consequences

- **+** `docker run -v ./data:/data -p 3001:3001 ghcr.io/…/uptime-monitoring` is the whole install.
- **+** The reverse-proxy majority (our NPM case) needs zero new infrastructure.
- **−** No bundled TLS/ACME; users without a proxy use docs for Caddy sidecar.
- **−** Kubernetes users wait for a chart (non-goal v1); the image is stateless-friendly
  (single replica + Postgres) meanwhile.
