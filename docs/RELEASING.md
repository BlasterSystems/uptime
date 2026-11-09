# Releasing

Use the `semantic-versioning` skill for version bumps, releases, and Git tags.

## Release contract

- Versions follow Semantic Versioning: `MAJOR.MINOR.PATCH`.
- Release tags are annotated and use `vMAJOR.MINOR.PATCH`.
- The changelog records user-visible changes.
- Tests and configured validators must pass before tagging.
- Publishing commits, tags, or packages requires separate explicit approval.

## Repository configuration

Decided 2026-11-09 (UP-8) and applied for v1.0.0:

1. **Authoritative version**: the root `package.json` `"version"` field. The
   workspace packages keep their own versions (they are private and never
   published to npm); the released artifact is the container image, tagged
   from the git tag.
2. **Derived references**: none — nothing else embeds the version. Images are
   tagged `vMAJOR.MINOR.PATCH`, `vMAJOR.MINOR` and `latest` by
   `.github/workflows/release.yml` from the pushed tag; the SBOM/provenance
   annotations are produced by the workflow.
3. **Required validation** before tagging: `pnpm lint`, `pnpm typecheck`,
   `pnpm test`, `pnpm coverage`, `pnpm test:e2e`, `pnpm build`,
   `.agentic/bin/validate`, `.agentic/bin/docs-check` (the CI `check` job runs
   the same set).
4. **Release branch and protection**: releases are tagged on `main` (linear
   history, ruleset `protect-main`). The release commit is
   `chore(release): vX.Y.Z` and the tag is **annotated** `vX.Y.Z` — pushing
   the tag is what triggers `release.yml` (buildx amd64+arm64 → GHCR + SBOM).
5. **Registry/deployment**: publishing is GHCR-only (container images
   `uptime-monitoring` + `uptime-agent`). `dev-*` tags are deployments, not
   releases; `v*` tags are releases and require explicit confirmation before
   the commit/tag is pushed.

Release smoke test (after the images publish): on a clean amd64 and arm64
host, `cp deploy/.env.example .env`, set `ENCRYPTION_KEY`, `docker compose up`
with the README deployment snippet, then verify `/healthz` and the first-run
setup flow; confirm an anonymous `docker pull` of the exact `vX.Y.Z` tags.

## Release checklist

1. Start from a clean Git worktree.
2. Review changes since the latest `v*` tag.
3. Propose and confirm the SemVer bump.
4. Update authoritative version sources and `CHANGELOG.md`.
5. Refresh generated artifacts.
6. Run all documented validation.
7. Review and confirm the release diff.
8. Create `chore(release): vX.Y.Z`.
9. Create annotated tag `vX.Y.Z`.
10. Verify the tagged version; push or publish only when explicitly requested.
