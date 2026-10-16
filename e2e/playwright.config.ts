import { defineConfig } from '@playwright/test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const PORT = 3399
export const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: join(here, 'specs'),
  globalSetup: join(here, 'global-setup.ts'),
  // Specs share one throwaway server instance and depend on its state.
  workers: 1,
  fullyParallel: false,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node ${join(here, 'serve.mjs')} node ${join(root, 'apps/server/dist/main.js')}`,
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      DATA_DIR: join(here, '.run-data'),
      SEED: '0',
      WEB_DIST: join(root, 'apps/web/dist'),
    },
    timeout: 30_000,
  },
})
