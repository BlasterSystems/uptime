/**
 * Boots the built server with a throwaway data dir: wipes DATA_DIR, then runs
 * the server in the foreground. Playwright's `webServer` uses this so every
 * E2E run starts from a fresh instance (admin seeded by global-setup).
 */
import { rmSync } from 'node:fs'
import { spawn } from 'node:child_process'

const dataDir = process.env.DATA_DIR
if (dataDir) rmSync(dataDir, { recursive: true, force: true })

const [command, ...args] = process.argv.slice(2)
if (!command) throw new Error('usage: node serve.mjs <command> [args...]')
const child = spawn(command, args, { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code === null ? 1 : code))
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig))
}
