# Deployment

Status: CONFIGURED

<!-- Project-owned: refract preserves edits to this file. Configured 2026-11-19
     from .github/workflows/{ci,cd-dev,release}.yml, deploy/, docs/RELEASING.md,
     and the GitHub repo settings (gh api), plus owner decisions. -->

## Environments

| Environment | Skill | Deploy from | Trigger | Tag pattern | Tag regex | Pipeline |
|---|---|---|---|---|---|---|
| dev | `deploy-dev` | Any pushed branch | Tag push | `dev-{YYMMDD}-{N}` | `^dev-[0-9]{6}-[0-9]+$` | `.github/workflows/cd-dev.yml` — `gh run watch` |
| prd | `deploy-prd` | Default branch (`main`), after squash merge | Tag push | `prd-{YYMMDD}-{N}` | `^prd-[0-9]{6}-[0-9]+$` | `.github/workflows/release.yml` — `gh run watch` |

- `{YYMMDD}` is the current UTC date; `{N}` is one more than the numerically
  highest existing tag for that date and environment (start at 1).
- Remote: `origin` (`git@github.com:BlasterSystems/uptime.git`). Default
  branch: `main` (protected by the `protect-main` ruleset).
- `dev-*` tags deploy to the Proxmox docker VM (LXC 106) over SSH; the image
  is built on the VM from a git bundle, so no GHCR credentials live there.
  `deploy/.env` on the VM is the source of truth; CI never rewrites it
  (`git clean` excludes it).
- `prd-*` tags publish dated images to GHCR from `.github/workflows/release.yml`
  (multi-arch, SBOM + provenance). They are **deployments, not releases**:
  `latest` and the `v*` SemVer tags stay reserved for releases per
  `docs/RELEASING.md`, and a `prd-*` push never moves them.

## Merge strategy

`deploy-prd` merges pull requests into `main` with **squash** (linear
history; GitHub deletes the source branch on merge). One **approving review
is required**: the skill verifies the review and every required check before
merging, pins the merge to the inspected head SHA, and stops on any drift.

## Pre-deploy gates

Run against the pinned commit, in this order (the CI `check` job runs the
same set, so an already-green `check` run on the SHA evidences 1–8):

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm coverage`
5. `pnpm test:e2e`
6. `pnpm build`
7. `.agentic/bin/validate`
8. `.agentic/bin/docs-check`
9. `.refract/bin/validate`

Additionally, the CI `check` workflow must be green on the pinned commit
(`gh run list --commit <sha>`). For commits CI has not seen (branch deploys
with no PR), run gates 1–9 locally instead.

## Post-deploy verification

- **Artifact invariants**:
  - dev: the VM checkout is detached at the pinned SHA
    (`git -C "$VM_DEPLOY_DIR" rev-parse HEAD`); `deploy/.env` on the VM is
    unchanged; `uptime-dev:latest` was built on the VM from that checkout
    with the `VITE_DEPLOY_TAG` stamp; the `uptime-dev` container runs with a
    read-only root filesystem and the `uptime-data` named volume.
  - prd: `ghcr.io/blastersystems/uptime-monitoring` and
    `ghcr.io/blastersystems/uptime-agent` carry the `prd-{YYMMDD}-{N}` tag;
    `docker buildx imagetools inspect …:prd-{YYMMDD}-{N}` lists
    `linux/amd64` and `linux/arm64` and shows SBOM + provenance attestations;
    `latest` and `v*` tags are unchanged.
- **Functional probes**:
  - dev: the in-workflow health gate (60 × 2 s against `/healthz` inside the
    container) passed in the watched run — quote the gate line from the run
    log as evidence. With SSH key access, re-check directly:
    `ssh "$VM_USER@$VM_HOST" "cd '$VM_DEPLOY_DIR' && docker compose -f deploy/docker-compose.yml exec -T uptime node -e \"fetch('http://127.0.0.1:3101/healthz').then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))\""` → prints `200`, exits 0.
  - prd: `docker pull` the exact `prd-{YYMMDD}-{N}` tag (authenticated;
    packages are private), run it with a throwaway key on a spare port
    (`docker run --rm -d --name prd-probe -p 3102:3101 -e PORT=3101 -e
    ENCRYPTION_KEY=$(openssl rand -hex 32) <image>`), probe
    `curl -fsS http://127.0.0.1:3102/healthz` → `200`, then remove the
    container. The full clean-host amd64+arm64 smoke test stays a `v*`
    release procedure per `docs/RELEASING.md`.
- **Evidence**: a comment on the GitHub issue or pull request that drove the
  change (the UP-xx convention) containing the tag, commit SHA, pipeline URL
  and result, and each probe command with its observed output.

A configuration change made outside the pipeline (console, CLI, secret
wiring) is a deploy: re-run the functional probes afterwards.

## Rollback

- **dev — automatic**: if the `/healthz` gate fails, `cd-dev.yml` re-tags the
  previous image (saved in `/tmp/uptime-dev.prev`) and restarts the
  container; the run still fails, so check why.
- **dev — manual**: re-deploy a known-good commit by dispatching `cd-dev`
  with `inputs.ref` set to the previous `dev-*` tag; or on the VM, re-tag
  the previous image and `docker compose -f deploy/docker-compose.yml up -d
  --no-deps uptime`. Never move or delete an existing tag.
- **prd**: GHCR images are immutable artifacts. Roll back by deploying the
  previous state as a **new** `prd-{YYMMDD}-{N}` tag (revert commit →
  squash merge → tag), or pin the previous image on the consuming host.
  Never move or delete an existing tag.
- **Authority**: only the repository owner may trigger or approve a
  rollback. The deploy skills ask for explicit confirmation before every
  merge, tag, and push.
