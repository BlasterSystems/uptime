export interface ServerConfig {
  port: number
  dataDir: string
  webDist: string | null
  seed: boolean
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 3001)
  return {
    port: Number.isInteger(port) && port > 0 ? port : 3001,
    dataDir: env.DATA_DIR ?? './data',
    webDist: env.WEB_DIST ?? null,
    seed: env.SEED !== '0',
  }
}
