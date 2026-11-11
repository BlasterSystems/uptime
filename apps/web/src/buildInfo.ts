/**
 * Deployment stamp baked into the bundle at build time: the git tag the image
 * was built from (`dev-*` / `v*`), injected as the `VITE_DEPLOY_TAG` build arg
 * by `cd-dev.yml` / `release.yml` (see docker/Dockerfile). Source builds that
 * run without the arg render 'source'.
 */
export function deployTag(): string {
  return import.meta.env.VITE_DEPLOY_TAG || 'source'
}
