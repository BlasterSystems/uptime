/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Git tag baked into the bundle at build time (footer stamp); unset in source builds. */
  readonly VITE_DEPLOY_TAG?: string
}
