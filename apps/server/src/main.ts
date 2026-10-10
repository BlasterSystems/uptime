import { Scheduler, runHttpCheck } from '@uptime/core'
import { Database } from '@uptime/db'
import { createApp, toScheduled } from './app.js'
import { readConfig } from './env.js'
import { Metrics } from './metrics.js'
import { seedIfEmpty } from './seed.js'

const ROLE = process.argv[2] ?? 'server'

if (ROLE !== 'server') {
  console.error(`unknown role "${ROLE}" — only "server" is implemented (agent lands in M5)`)
  process.exit(1)
}

const cfg = readConfig()
const db = Database.openDir(cfg.dataDir)
const metrics = new Metrics()

const scheduler = new Scheduler({
  check: (m) => runHttpCheck(m.config),
  onResult: (m, result, time) => {
    db.insertHeartbeat({
      monitorId: m.id,
      status: result.status,
      latencyMs: result.latencyMs,
      responseSnippet: result.responseSnippet,
      time,
    })
    metrics.setMonitorUp(m.id, m.name, result.status === 'up')
  },
})

seedIfEmpty(db, scheduler)

for (const row of db.listMonitors()) {
  if (row.active && row.type === 'http') scheduler.upsert(toScheduled(row))
}

const app = createApp({ db, scheduler, metrics, webDist: cfg.webDist })
scheduler.start()

let closing = false
const server = app.listen(cfg.port, () => {
  console.log(`uptime-monitoring server listening on :${cfg.port} (data: ${cfg.dataDir})`)
})

const shutdown = () => {
  if (closing) return
  closing = true
  scheduler.stop()
  server.close(() => {
    db.close()
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
