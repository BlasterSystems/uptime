# Security Policy

## Reporting a vulnerability

Please use **GitHub private vulnerability reporting** (the *Security* tab →
*Report a vulnerability*) — it keeps the report, discussion and fix private
until a patched release is out.

If you cannot use GitHub, email **bruno@blastersystems.com** with
`[uptime] security` in the subject. Please do not open a public issue for
something exploitable.

Include, when relevant:

- Version (image tag or commit) and deployment shape (compose, proxy in front).
- The affected surface: admin API, public status pages, push receiver, agent
  control plane, `/metrics`.
- Steps or a minimal reproduction. Do not include real secrets or customer
  data; the check engine config is JSON and safe to redact.

You can expect an initial response within a few days. Fixes are released as a
patch release; reports get credit in the release notes unless you prefer
otherwise.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | yes |
| < 1.0 | no (never publicly released) |

## Security-relevant defaults

Worth knowing when reporting (details in [docs/SPEC.md](docs/SPEC.md) §8):

- The unauthenticated surface is deliberately tiny: `/healthz`, `/metrics`
  (open by default, restrict with `METRICS_ALLOWLIST`), the push receiver
  (the path token is the secret), published status pages, and password
  recovery. `/auth/setup` is only open while the instance has no admin user.
- Secrets at rest (notification configs, docker TLS material, TOTP secrets)
  are AES-256-GCM encrypted under `ENCRYPTION_KEY`.
- The container runs as non-root and is `read_only: true` compatible; TLS is
  delegated to the reverse proxy in front of the container.

## Verified builds

Release images are built from the repo's GitHub Actions workflow
(`release.yml`, buildx + SBOM) on `v*` tags and published to
`ghcr.io/blastersystems/uptime-monitoring` / `uptime-agent`. Prefer digest-
pinned pulls for production.
