export interface ServerConfig {
  port: number
  dataDir: string
  webDist: string | null
  seed: boolean
  encryptionKey: string | undefined
  /** Raw TRUST_PROXY value (Express `trust proxy`); unset = direct exposure. */
  trustProxy: string | undefined
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 3001)
  return {
    port: Number.isInteger(port) && port > 0 ? port : 3001,
    dataDir: env.DATA_DIR ?? './data',
    webDist: env.WEB_DIST ?? null,
    // Demo seed is opt-in (SEED=1): a fresh production volume must not boot
    // with a fabricated monitor. `pnpm dev` and the root compose pass SEED=1.
    seed: env.SEED === '1',
    encryptionKey: env.ENCRYPTION_KEY,
    trustProxy: env.TRUST_PROXY?.trim() === '' ? undefined : env.TRUST_PROXY?.trim(),
  }
}
