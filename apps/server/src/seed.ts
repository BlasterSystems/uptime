import type { Database } from '@uptime/db'
import { toScheduled, type SchedulerLike } from './app.js'

export function seedIfEmpty(db: Database, scheduler?: SchedulerLike): boolean {
  if (db.listMonitors().length > 0) return false
  const row = db.createMonitor({
    type: 'http',
    name: 'Example',
    intervalS: 60,
    retries: 1,
    retryIntervalS: 60,
    config: {
      url: 'https://example.com/',
      method: 'GET',
      timeoutMs: 10000,
      acceptedStatus: [200, 299],
    },
  })
  scheduler?.upsert(toScheduled(row))
  return true
}
