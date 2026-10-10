import { Scheduler, runHttpCheck } from '@uptime/core'
import { Notifier, type ChannelType } from '@uptime/notify'
import { Database, SecretBox } from '@uptime/db'
import { createApp, toScheduled } from './app.js'
import { createAuthModule } from './auth/index.js'
import { readConfig } from './env.js'
import { IncidentEngine } from './incidents.js'
import { Metrics } from './metrics.js'
import { PushEngine } from './push.js'
import { seedIfEmpty } from './seed.js'

const ROLE = process.argv[2] ?? 'server'

if (ROLE !== 'server') {
  console.error(`unknown role "${ROLE}" — only "server" is implemented (agent lands in M5)`)
  process.exit(1)
}

const cfg = readConfig()
const secrets = new SecretBox(cfg.encryptionKey)
if (secrets.isEphemeral) {
  console.warn(
    'WARNING: ENCRYPTION_KEY is not set — notification configs and TOTP secrets will be unreadable after restart. Generate one with: openssl rand -hex 32',
  )
}

const db = Database.openDir(cfg.dataDir)
const metrics = new Metrics()

const notifier = new Notifier({
  channels: () =>
    db.listChannels().map((c) => {
      try {
        return {
          id: c.id,
          type: c.type as ChannelType,
          name: c.name,
          config: secrets.decryptJson<Record<string, unknown>>(c.configEnc),
          active: c.active,
        }
      } catch {
        console.warn(`notification channel ${c.id} (${c.name}) could not be decrypted — skipped`)
        return { id: c.id, type: c.type as ChannelType, name: c.name, config: {}, active: false }
      }
    }),
  monitorChannelIds: (monitorId) => db.listMonitorChannelIds(monitorId),
  defaultChannelIds: () =>
    db
      .listChannels()
      .filter((c) => c.isDefault && c.active)
      .map((c) => c.id),
})

const incidentEngine = new IncidentEngine({
  db,
  notifier,
  tags: (monitorId) => {
    const byId = new Map(db.listTags().map((t) => [t.id, t]))
    return db.listMonitorTagIds(monitorId).flatMap((id) => {
      const t = byId.get(id)
      return t ? [t.name] : []
    })
  },
})

const pushEngine = new PushEngine({
  db,
  onDown: (m, reason, time) => incidentEngine.onPushDown(m, reason, time),
})

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
    void incidentEngine.onResult(m, result, time)
  },
})

seedIfEmpty(db, scheduler)

for (const row of db.listMonitors()) {
  if (row.active && row.type === 'http') scheduler.upsert(toScheduled(row))
}

const app = createApp({
  db,
  secrets,
  notifier,
  auth: createAuthModule({ db, secrets }),
  scheduler,
  metrics,
  webDist: cfg.webDist,
  incidentEngine,
})
scheduler.start()
pushEngine.start()

let closing = false
const server = app.listen(cfg.port, () => {
  console.log(`uptime-monitoring server listening on :${cfg.port} (data: ${cfg.dataDir})`)
})

const shutdown = () => {
  if (closing) return
  closing = true
  scheduler.stop()
  pushEngine.stop()
  server.close(() => {
    db.close()
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
