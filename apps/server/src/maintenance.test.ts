import { describe, expect, it } from 'vitest'
import { Database } from '@uptime/db'
import { MaintenanceEngine } from './maintenance.js'

function makeDb() {
  return Database.open({ file: ':memory:' })
}

function engine(db: Database) {
  return new MaintenanceEngine({ db, tagIdsOf: (id) => db.listMonitorTagIds(id) })
}

describe('MaintenanceEngine.matches', () => {
  it('matches scopes all/ids/tags', () => {
    const db = makeDb()
    const m1 = db.createMonitor({ type: 'http', name: 'a', intervalS: 60, retries: 1, retryIntervalS: 60, config: {} })
    const m2 = db.createMonitor({ type: 'http', name: 'b', intervalS: 60, retries: 1, retryIntervalS: 60, config: {} })
    const tag = db.createTag('prod')
    db.setMonitorTags(m1.id, [tag.id])

    const all = db.createMaintenanceWindow({ name: 'all', scope: 'all', strategy: 'single', startAt: new Date('2026-01-01T00:00:00Z'), endAt: new Date('2026-01-01T01:00:00Z') })
    const ids = db.createMaintenanceWindow({ name: 'ids', scope: 'ids', monitorIds: [m2.id], strategy: 'single', startAt: new Date('2026-01-01T00:00:00Z'), endAt: new Date('2026-01-01T01:00:00Z') })
    const tags = db.createMaintenanceWindow({ name: 'tags', scope: 'tags', tagIds: [tag.id], strategy: 'single', startAt: new Date('2026-01-01T00:00:00Z'), endAt: new Date('2026-01-01T01:00:00Z') })

    const e = engine(db)
    expect(e.matches(all, [m1.id])).toBe(true)
    expect(e.matches(ids, [m2.id])).toBe(true)
    expect(e.matches(ids, [m1.id])).toBe(false)
    expect(e.matches(tags, [m1.id])).toBe(true) // m1 carries the tag
    expect(e.matches(tags, [m2.id])).toBe(false)
    db.close()
  })
})

describe('MaintenanceEngine.listFor', () => {
  it('splits active and upcoming windows for the given monitors', () => {
    const db = makeDb()
    const m = db.createMonitor({ type: 'http', name: 'a', intervalS: 60, retries: 1, retryIntervalS: 60, config: {} })
    const now = new Date('2026-01-10T12:00:00Z')

    db.createMaintenanceWindow({
      name: 'active-now',
      scope: 'ids',
      monitorIds: [m.id],
      strategy: 'single',
      startAt: new Date('2026-01-10T11:00:00Z'),
      endAt: new Date('2026-01-10T13:00:00Z'),
    })
    db.createMaintenanceWindow({
      name: 'later-today',
      scope: 'all',
      strategy: 'single',
      startAt: new Date('2026-01-10T18:00:00Z'),
      endAt: new Date('2026-01-10T19:00:00Z'),
    })
    db.createMaintenanceWindow({
      name: 'beyond-horizon',
      scope: 'all',
      strategy: 'single',
      startAt: new Date('2026-02-01T00:00:00Z'),
      endAt: new Date('2026-02-01T01:00:00Z'),
    })

    const listing = engine(db).listFor([m.id], now)
    expect(listing.active.map((w) => w.name)).toEqual(['active-now'])
    expect(listing.upcoming.map((w) => w.name)).toEqual(['later-today'])
    db.close()
  })

  it('computes the next occurrence for weekday windows', () => {
    const db = makeDb()
    const m = db.createMonitor({ type: 'http', name: 'a', intervalS: 60, retries: 1, retryIntervalS: 60, config: {} })
    // 2026-01-10 is a Saturday (UTC day 6). Window runs Sundays 03:00–04:00 UTC.
    const now = new Date('2026-01-10T12:00:00Z')
    db.createMaintenanceWindow({
      name: 'sunday-window',
      scope: 'all',
      strategy: 'recurring-weekday',
      weekdays: [0],
      startTime: '03:00',
      endTime: '04:00',
    })
    const listing = engine(db).listFor([m.id], now)
    expect(listing.active).toHaveLength(0)
    expect(listing.upcoming.map((w) => w.name)).toEqual(['sunday-window'])
    db.close()
  })
})
