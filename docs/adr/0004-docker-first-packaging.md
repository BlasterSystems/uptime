# ADR-0004: Docker-first packaging — one image, two roles, compose default

- **Status:** Accepted
- **Date:** 2026-10-10
- **Decision owners:** Not assigned
- **Scope:** Container packaging, CI release pipeline, TLS boundary, configuration precedence
- **Tags:** docker, ci, packaging, deployment
- **Supersedes:** None
- **Superseded by:** None

## Context

The audience runs Docker on single VMs (our case: Proxmox LXCs, compose, existing
reverse proxy). Competitors set expectations: Uptime-Kuma = one image + volume;
Gatus = one binary; PulseMonitor = three repos. CI must produce multi-arch images.

## Decision drivers

- Audience deployment reality: Docker on single VMs, compose, an existing reverse proxy.
- Competitor expectations set a one-image install bar (Kuma) with minimal new
  infrastructure (Gatus).
- CI must produce multi-arch (amd64/arm64) images with supply-chain metadata.
- Secure defaults: non-root runtime, read-only-rootfs-compatible container.
- Configuration precedence must be explainable: UI/database is the live source of truth,
  env supplies deployment settings, files only import/export (SPEC §5).

## Considered options

### Option 1: One Dockerfile, server + agent roles, compose default (chosen)

A `server` image (default) and an `agent` variant via entrypoint subcommand dispatch
(ADR-0003), with `docker compose up` as the documented happy path.

### Option 2: Separate images per component (PulseMonitor-like)

Independent release cycles, but three artifacts to build, version, and document —
rejected for operational overhead.

### Option 3: Single static binary (Gatus-like)

Excellent distribution story, but a worse UI/embedded-database story and it abandons the
Docker-first audience (SPEC §1).

### Option 4: Bundled TLS/ACME in the container

Removes the reverse-proxy requirement, but expands the container's security surface and
duplicates infrastructure the target audience already runs; rejected in favor of
delegating TLS to the user's reverse proxy.

### Option 5: Kubernetes-first packaging

Helm charts/operators target a different audience and are an explicit v1 non-goal
(SPEC §1); the image stays stateless-friendly for a future chart.

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

### Positive

- `docker run -v ./data:/data -p 3001:3001 ghcr.io/…/uptime-monitoring` is the whole
  install.
- The reverse-proxy majority (our NPM case) needs zero new infrastructure.

### Negative

- No bundled TLS/ACME; users without a proxy use docs for Caddy sidecar.
- Kubernetes users wait for a chart (non-goal v1); the image is stateless-friendly
  (single replica + Postgres) meanwhile.

### Risks and mitigations

- Risk: multi-arch builds are slow or flaky in CI. Mitigation: buildx runs on `v*` tags;
  PR workflows run lint/typecheck/tests without image builds.
- Risk: `read_only: true` breaks writes outside `/data` and `/tmp`. Mitigation: tmpfs
  `/tmp`, documented compose file, healthcheck.
- Risk: users treat the imported config file as the live source of truth. Mitigation:
  import/export only, with precedence documented as DB > env > defaults.

## Implementation and validation

The image, compose file, `/data` volume, and healthcheck are PLAN.md M1 deliverables;
multi-arch buildx → GHCR with SBOM and semver releases are M5 (per RELEASING.md). The M1
exit criterion (`docker compose up` → HTTP monitor → heartbeat in the UI) validates the
packaging, and the M5 exit criterion validates the arm64 build. Current repository
validation is `.agentic/bin/validate` plus `.agentic/bin/docs-check`.

## Revisit triggers

- Kubernetes/Helm becomes a real v1+ requirement.
- Bundled TLS/ACME requests make reverse-proxy delegation a support burden.
- Multi-arch image size or build cost outweighs arm64 demand.

## References

- [SPEC.md](../SPEC.md) — docker packaging, goals and non-goals.
- [PLAN.md](../PLAN.md) — M1 image/compose, M5 multi-arch release.
- [RELEASING.md](../RELEASING.md) — semantic versioning and release workflow.
- [ARCHITECTURE.md](../ARCHITECTURE.md)
- [ADR-0003](0003-agentless-core-optional-agents.md) — agent role dispatch.
