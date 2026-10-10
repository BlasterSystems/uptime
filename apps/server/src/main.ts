import { runAgentCli } from '@uptime/agent'
import { getCertExpiryDays, Scheduler, runHttpCheck, parseMonitorConfig } from '@uptime/core'
import type { HttpMonitorConfig } from '@uptime/core'
import { Notifier, type ChannelType } from '@uptime/notify'
import { Database, SecretBox } from '@uptime/db'
import { createApp, toScheduled } from './app.js'
import { createAuthModule } from './auth/index.js'
import { readConfig } from './env.js'
import { EventHub } from './events.js'
import { GroupEngine } from './groups.js'
import { IncidentEngine } from './incidents.js'
import { MaintenanceEngine } from './maintenance.js'
import { Metrics } from './metrics.js'
import { PushEngine } from './push.js'
import { seedIfEmpty } from './seed.js'

const ROLE = process.argv[2] ?? 'server'

if (ROLE === 'agent') {
  await runAgentCli()
  process.exit(0)
} else if (ROLE !== 'server') {
  console.error(`unknown role "${ROLE}" — only "server" and "agent" are implemented`)
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
const hub = new EventHub()

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
  // SPEC §3 groups: while a containing group monitor is down, member notifications are suppressed.
  isSuppressed: (monitorId) => {
    for (const row of db.listMonitors()) {
      if (row.type !== 'group' || !row.active) continue
      const cfg = row.config as { memberIds?: unknown }
      if (!Array.isArray(cfg.memberIds) || !cfg.memberIds.includes(monitorId)) continue
      const [latest] = db.listHeartbeats(row.id, { limit: 1 })
      if (latest?.status === 'down') return true
    }
    return false
  },
  onEvent: (event) => hub.broadcast(event),
})

const groupEngine = new GroupEngine({
  db,
  onResult: (m, result, time) => incidentEngine.onResult(m, result, time),
  broadcast: (event) => hub.broadcast(event),
})

const maintenance = new MaintenanceEngine({
  db,
  tagIdsOf: (monitorId) => db.listMonitorTagIds(monitorId),
})

const pushEngine = new PushEngine({
  db,
  onDown: (m, reason, time) => incidentEngine.onPushDown(m, reason, time),
})

const scheduler = new Scheduler({
  check: (m) => {
    // The scheduler only probes http monitors (upsert skips every other type),
    // so the union config is guaranteed to be the http variant here.
    const httpConfig = m.config as HttpMonitorConfig
    return runHttpCheck(httpConfig)
  },
  onResult: (m, result, time) => {
    const under = maintenance.isUnder(m.id, time)
    const status = under ? 'maintenance' : result.status
    db.insertHeartbeat({
      monitorId: m.id,
      status,
      latencyMs: result.latencyMs,
      responseSnippet: result.responseSnippet,
      time,
    })
    metrics.setMonitorUp(m.id, m.name, status === 'up')
    metrics.setMaintenance(m.id, m.name, under)
    if (result.latencyMs !== undefined) metrics.observeLatency(m.id, m.name, result.latencyMs)
    hub.broadcast({
      type: 'heartbeat',
      monitorId: m.id,
      status,
      latencyMs: result.latencyMs ?? null,
      time: time.toISOString(),
    })
    if (!under) void incidentEngine.onResult(m, result, time)
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
  eventHub: hub,
  maintenance,
  dataDir: cfg.dataDir,
  agentToken: process.env.UPTIME_AGENT_TOKEN ?? '',
})
scheduler.start()
pushEngine.start()
groupEngine.start()

// Rollup job (SPEC §4 retention model — review B3): aggregate heartbeats hourly.
const runRollup = () => {
  try {
    db.rollupHeartbeats(new Date())
  } catch (err) {
    console.warn(`rollup failed: ${err instanceof Error ? err.message : err}`)
  }
}
runRollup()
const rollupTimer = setInterval(runRollup, 15_000)
rollupTimer.unref?.()

// Cert-expiry probe (SPEC §3/§11): refresh gauge for https monitors every 6 h.
const probeCerts = async () => {
  for (const row of db.listMonitors()) {
    if (row.type !== 'http' || !row.active) continue
    try {
      const cfgHttp = parseMonitorConfig('http', row.config)
      if (!cfgHttp.url.startsWith('https://')) continue
      const days = await getCertExpiryDays(cfgHttp.url)
      if (days !== null) metrics.setCertExpiryDays(row.id, row.name, days)
    } catch {
      // probe failures leave the previous gauge value in place
    }
  }
}
void probeCerts()
const certTimer = setInterval(() => void probeCerts(), 6 * 3600_000)
certTimer.unref?.()

// Per-tag aggregate gauges (SPEC §11).
const refreshTagGauges = () => {
  try {
    const tagById = new Map(db.listTags().map((t) => [t.id, t]))
    const rows = db.listMonitors()
    const tagIdsBy = db.listTagIdsForMonitors(rows.map((r) => r.id))
    const counts = new Map<string, { up: number; down: number }>()
    for (const row of rows) {
      const [latest] = db.listHeartbeats(row.id, { limit: 1 })
      const status = latest?.status ?? 'pending'
      for (const tagId of tagIdsBy[row.id] ?? []) {
        const tag = tagById.get(tagId)
        if (!tag) continue
        const c = counts.get(tag.name) ?? { up: 0, down: 0 }
        if (status === 'up') c.up += 1
        else if (status === 'down') c.down += 1
        counts.set(tag.name, c)
      }
    }
    for (const [tag, c] of counts) metrics.setTagCounts(tag, c.up, c.down)
  } catch {
    // best-effort; gauges keep previous values
  }
}
refreshTagGauges()
const tagTimer = setInterval(refreshTagGauges, 30_000)
tagTimer.unref?.()

let closing = false
const server = app.listen(cfg.port, () => {
  console.log(`uptime-monitoring server listening on :${cfg.port} (data: ${cfg.dataDir})`)
})

const shutdown = () => {
  if (closing) return
  closing = true
  scheduler.stop()
  pushEngine.stop()
  groupEngine.stop()
  hub.stop()
  clearInterval(rollupTimer)
  clearInterval(certTimer)
  clearInterval(tagTimer)
  server.close(() => {
    db.close()
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
