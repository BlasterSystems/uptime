import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Sqlite from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Database } from './index.js'
import type { ChannelRow, HeartbeatStatus, MonitorRow, StatusPageRow } from './index.js'

const DAY_MS = 86_400_000

/** UTC day start (unix ms) — the bucket `heartbeats_daily` rolls into. */
function utcDayStart(time: number): number {
  return Math.floor(time / DAY_MS) * DAY_MS
}

function utcDate(bucket: number): string {
  return new Date(bucket).toISOString().slice(0, 10)
}

function createPushMonitor(db: Database, name = 'push'): MonitorRow {
  return db.createMonitor({
    type: 'push',
    name,
    intervalS: 60,
    retries: 1,
    retryIntervalS: 60,
    config: {},
  })
}

describe('status page migrations', () => {
  it('applies to a fresh in-memory database', () => {
    const db = Database.open({ file: ':memory:' })
    try {
      const page = db.createStatusPage({ slug: 'status', title: 'Status' })
      expect(page.structure).toEqual({})
      expect(db.createStatusIncident({ pageId: page.id, title: 'first' }).id).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('creates the status tables and the new status_pages columns on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptime-status-'))
    const db = Database.openDir(dir)
    try {
      const raw = new Sqlite(join(dir, 'uptime.db'))
      try {
        const tables = raw
          .prepare<[], string>("select name from sqlite_master where type = 'table'")
          .pluck()
          .all()
        expect(tables).toEqual(
          expect.arrayContaining([
            'status_incidents',
            'status_incident_updates',
            'status_subscriptions',
          ]),
        )
        const columns = raw
          .prepare<[], { name: string }>('pragma table_info(status_pages)')
          .all()
          .map((column) => column.name)
        expect(columns).toEqual(
          expect.arrayContaining(['structure', 'footer_text', 'password_hash']),
        )
      } finally {
        raw.close()
      }
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('status page content', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('round-trips structure, footer and the password hash with its derived flag', () => {
    const created = db.createStatusPage({ slug: 'status', title: 'Status' })
    expect(created).toMatchObject({
      structure: {},
      footerText: null,
      hasPassword: false,
      passwordHash: null,
    })

    const structure = {
      groups: [
        {
          name: 'API',
          components: [
            {
              monitorId: 1,
              label: 'edge',
              description: 'Public API',
              showUptime: true,
              showChart: false,
            },
          ],
        },
      ],
    }
    const protectedPage = db.createStatusPage({
      slug: 'private',
      title: 'Private',
      structure,
      footerText: 'Internal status page',
      passwordHash: 'argon2id$hash',
    })
    expect(protectedPage.structure).toEqual(structure)
    expect(protectedPage.footerText).toBe('Internal status page')
    expect(protectedPage.hasPassword).toBe(true)
    expect(protectedPage.passwordHash).toBe('argon2id$hash')

    // The row is the internal view: hash and flag both survive a round-trip and
    // the API layer (not this layer) strips them.
    expect(db.getStatusPage(protectedPage.id)).toEqual(protectedPage)
    expect(db.getPublicStatusPage('private')).toBeNull()
  })

  it('accepts structure as validated JSON text and clears it back to {} with null', () => {
    const structure = {
      groups: [{ name: 'API', components: [{ id: 'api', label: 'API', monitorIds: [1] }] }],
      autoPublish: false,
    }
    const created = db.createStatusPage({
      slug: 'status',
      title: 'Status',
      structure: JSON.stringify(structure),
    })
    expect(created.structure).toEqual(structure)

    const cleared = db.updateStatusPage(created.id, { structure: null })
    expect(cleared?.structure).toEqual({})
  })

  it('replaces structure wholesale and clears footer/password with null', () => {
    const created = db.createStatusPage({
      slug: 'status',
      title: 'Status',
      structure: { groups: [] },
      footerText: 'footer',
      passwordHash: 'hash',
    })

    const updated = db.updateStatusPage(created.id, {
      structure: { groups: [{ name: 'Web', components: [] }] },
      footerText: null,
      passwordHash: null,
    })
    expect(updated).toMatchObject({
      structure: { groups: [{ name: 'Web', components: [] }] },
      footerText: null,
      hasPassword: false,
      passwordHash: null,
    })

    const untouched = db.updateStatusPage(created.id, { title: 'Renamed' })
    expect(untouched?.structure).toEqual({ groups: [{ name: 'Web', components: [] }] })
    expect(untouched?.footerText).toBeNull()
  })
})

describe('status incidents', () => {
  let db: Database
  let page: StatusPageRow

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
    page = db.createStatusPage({ slug: 'status', title: 'Status' })
  })

  afterEach(() => {
    db.close()
  })

  it('creates the incident and its first update in one call', () => {
    const created = db.createStatusIncident({ pageId: page.id, title: 'API down' })
    expect(created).toMatchObject({
      pageId: page.id,
      title: 'API down',
      status: 'investigating',
      impact: 'major',
      componentIds: [],
      source: 'manual',
      monitorId: null,
      resolvedAt: null,
    })
    expect(created.createdAt).toEqual(created.updatedAt)

    const detail = db.getStatusIncident(created.id)
    expect(detail?.updates).toHaveLength(1)
    expect(detail?.updates[0]).toMatchObject({
      incidentId: created.id,
      status: 'investigating',
      body: 'API down',
      createdAt: created.createdAt,
    })
    expect(db.getStatusIncident(created.id + 1000)).toBeNull()
  })

  it('stores explicit fields and parses component ids back', () => {
    const created = db.createStatusIncident({
      pageId: page.id,
      title: 'Elevated latency',
      status: 'identified',
      impact: 'minor',
      componentIds: ['api', 'db'],
      source: 'auto',
      monitorId: 42,
    })
    expect(created).toMatchObject({
      status: 'identified',
      impact: 'minor',
      componentIds: ['api', 'db'],
      source: 'auto',
      monitorId: 42,
    })

    const detail = db.getStatusIncident(created.id)
    expect(detail?.updates[0]).toMatchObject({ status: 'identified', body: 'Elevated latency' })
  })

  it('appends updates, stamping resolved_at on resolve and clearing it otherwise', () => {
    const created = db.createStatusIncident({ pageId: page.id, title: 'API down' })

    const identified = db.addStatusIncidentUpdate(created.id, {
      status: 'identified',
      body: 'Found the cause',
    })
    expect(identified?.status).toBe('identified')
    expect(identified?.resolvedAt).toBeNull()
    expect(identified?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())

    const resolved = db.addStatusIncidentUpdate(created.id, {
      status: 'resolved',
      body: 'Fixed',
    })
    expect(resolved?.status).toBe('resolved')
    expect(resolved?.resolvedAt).toBeInstanceOf(Date)
    expect(resolved?.resolvedAt?.getTime()).toBeGreaterThanOrEqual(created.createdAt.getTime())

    // A later non-resolved status reopens the incident.
    const reopened = db.addStatusIncidentUpdate(created.id, {
      status: 'monitoring',
      body: 'Watching',
    })
    expect(reopened?.status).toBe('monitoring')
    expect(reopened?.resolvedAt).toBeNull()
    expect(reopened?.updates.map((update) => [update.status, update.body])).toEqual([
      ['investigating', 'API down'],
      ['identified', 'Found the cause'],
      ['resolved', 'Fixed'],
      ['monitoring', 'Watching'],
    ])

    expect(
      db.addStatusIncidentUpdate(created.id + 1000, { status: 'resolved', body: 'x' }),
    ).toBeNull()
    expect(db.getStatusIncident(created.id + 1000)).toBeNull()
  })

  it('edits incident fields without writing a timeline entry', () => {
    const created = db.createStatusIncident({
      pageId: page.id,
      title: 'API down',
      componentIds: ['api'],
    })

    const updated = db.updateStatusIncident(created.id, {
      title: 'API partially down',
      impact: 'critical',
      componentIds: ['api', 'db'],
    })
    expect(updated).toMatchObject({
      title: 'API partially down',
      impact: 'critical',
      componentIds: ['api', 'db'],
      status: 'investigating',
      resolvedAt: null,
    })
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())
    expect(db.getStatusIncident(created.id)?.updates).toHaveLength(1)

    expect(db.updateStatusIncident(created.id + 1000, { title: 'nope' })).toBeNull()
  })

  it('finds the open auto incident per monitor and resolves them in bulk', () => {
    const other = db.createStatusPage({ slug: 'other', title: 'Other' })
    const first = db.createStatusIncident({
      pageId: page.id,
      title: 'auto',
      source: 'auto',
      monitorId: 7,
    })
    const second = db.createStatusIncident({
      pageId: page.id,
      title: 'auto again',
      source: 'auto',
      monitorId: 7,
    })
    const manual = db.createStatusIncident({
      pageId: page.id,
      title: 'manual',
      source: 'manual',
      monitorId: 7,
    })
    const otherMonitor = db.createStatusIncident({
      pageId: page.id,
      title: 'other monitor',
      source: 'auto',
      monitorId: 8,
    })
    const otherPage = db.createStatusIncident({
      pageId: other.id,
      title: 'other page',
      source: 'auto',
      monitorId: 7,
    })

    expect(db.getOpenStatusIncidentForMonitor(page.id, 7)?.id).toBe(second.id)
    expect(db.getOpenStatusIncidentForMonitor(page.id, 8)?.id).toBe(otherMonitor.id)
    expect(db.getOpenStatusIncidentForMonitor(page.id, 9)).toBeNull()
    expect(db.getOpenStatusIncidentForMonitor(other.id, 7)?.id).toBe(otherPage.id)

    expect(db.resolveOpenStatusIncidentsForMonitor(page.id, 7, 'Monitor recovered')).toBe(2)
    expect(db.getOpenStatusIncidentForMonitor(page.id, 7)).toBeNull()

    const resolved = db.getStatusIncident(first.id)
    expect(resolved?.status).toBe('resolved')
    expect(resolved?.resolvedAt).toBeInstanceOf(Date)
    expect(resolved?.updates.at(-1)).toMatchObject({
      status: 'resolved',
      body: 'Monitor recovered',
    })
    expect(db.getStatusIncident(second.id)?.resolvedAt).toBeInstanceOf(Date)

    // Nothing left open for that monitor; manual and foreign rows keep their state.
    expect(db.resolveOpenStatusIncidentsForMonitor(page.id, 7, 'again')).toBe(0)
    expect(db.getStatusIncident(manual.id)?.resolvedAt).toBeNull()
    expect(db.getStatusIncident(manual.id)?.status).toBe('investigating')
    expect(db.getStatusIncident(otherMonitor.id)?.resolvedAt).toBeNull()
    expect(db.getStatusIncident(otherPage.id)?.resolvedAt).toBeNull()
  })

  it('lists incidents newest first with active and limit filters', () => {
    const first = db.createStatusIncident({ pageId: page.id, title: 'first' })
    const second = db.createStatusIncident({ pageId: page.id, title: 'second' })
    const third = db.createStatusIncident({ pageId: page.id, title: 'third' })
    db.addStatusIncidentUpdate(second.id, { status: 'resolved', body: 'done' })

    expect(db.listStatusIncidents({ pageId: page.id }).map((row) => row.id)).toEqual([
      third.id,
      second.id,
      first.id,
    ])
    expect(db.listStatusIncidents({ pageId: page.id, active: true }).map((row) => row.id)).toEqual([
      third.id,
      first.id,
    ])
    expect(db.listStatusIncidents({ pageId: page.id, active: false }).map((row) => row.id)).toEqual(
      [second.id],
    )
    expect(db.listStatusIncidents({ limit: 2 }).map((row) => row.id)).toEqual([third.id, second.id])
    expect(db.listStatusIncidents({ pageId: page.id + 1000 })).toEqual([])
  })

  it('cascades incidents and their updates when the page is deleted', () => {
    const created = db.createStatusIncident({ pageId: page.id, title: 'gone' })
    expect(db.getStatusIncident(created.id)?.updates).toHaveLength(1)

    expect(db.deleteStatusPage(page.id)).toBe(true)
    expect(db.getStatusIncident(created.id)).toBeNull()
    expect(db.listStatusIncidents()).toEqual([])
  })
})

describe('status subscriptions', () => {
  let db: Database
  let page: StatusPageRow
  let channel: ChannelRow

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
    page = db.createStatusPage({ slug: 'status', title: 'Status' })
    channel = db.createChannel({ type: 'email', name: 'Ops', configEnc: 'enc' })
  })

  afterEach(() => {
    db.close()
  })

  it('creates, lists, reads and deletes subscriptions', () => {
    const created = db.createStatusSubscription({
      pageId: page.id,
      channelId: channel.id,
      componentIds: ['api'],
      events: ['incident_open', 'incident_resolved'],
    })
    expect(created).toMatchObject({
      pageId: page.id,
      channelId: channel.id,
      componentIds: ['api'],
      events: ['incident_open', 'incident_resolved'],
    })
    expect(created.createdAt).toBeInstanceOf(Date)

    const slack = db.createChannel({ type: 'slack', name: 'Slack', configEnc: 'enc' })
    const defaults = db.createStatusSubscription({ pageId: page.id, channelId: slack.id })
    expect(defaults).toMatchObject({ componentIds: [], events: [] })

    expect(db.listStatusSubscriptions(page.id).map((row) => row.id)).toEqual([
      created.id,
      defaults.id,
    ])
    expect(db.listStatusSubscriptions(page.id + 1000)).toEqual([])
    expect(db.getStatusSubscription(created.id)).toEqual(created)
    expect(db.getStatusSubscription(created.id + 1000)).toBeNull()

    expect(db.deleteStatusSubscription(created.id)).toBe(true)
    expect(db.deleteStatusSubscription(created.id)).toBe(false)
    expect(db.listStatusSubscriptions(page.id).map((row) => row.id)).toEqual([defaults.id])
  })

  it('rejects a duplicate page/channel pair but allows the channel on another page', () => {
    db.createStatusSubscription({ pageId: page.id, channelId: channel.id })
    expect(() => db.createStatusSubscription({ pageId: page.id, channelId: channel.id })).toThrow()

    const other = db.createStatusPage({ slug: 'other', title: 'Other' })
    const second = db.createStatusSubscription({ pageId: other.id, channelId: channel.id })
    expect(second.pageId).toBe(other.id)
  })

  it('joins subscriptions with their channel for delivery', () => {
    const slack = db.createChannel({ type: 'slack', name: 'Slack', configEnc: 'enc' })
    db.createStatusSubscription({
      pageId: page.id,
      channelId: channel.id,
      events: ['incident_open'],
    })
    db.createStatusSubscription({
      pageId: page.id,
      channelId: slack.id,
      componentIds: ['api'],
    })

    expect(
      db
        .listSubscriptionsForPage(page.id)
        .map((row) => [row.channelId, row.channel.id, row.channel.name]),
    ).toEqual([
      [channel.id, channel.id, 'Ops'],
      [slack.id, slack.id, 'Slack'],
    ])
    expect(db.listSubscriptionsForPage(page.id + 1000)).toEqual([])

    // Deleting the channel cascades away its subscription only.
    expect(db.deleteChannel(slack.id)).toBe(true)
    expect(db.listSubscriptionsForPage(page.id).map((row) => row.channel.name)).toEqual(['Ops'])
  })

  it('cascades subscriptions when the page is deleted', () => {
    const created = db.createStatusSubscription({ pageId: page.id, channelId: channel.id })
    expect(db.deleteStatusPage(page.id)).toBe(true)
    expect(db.getStatusSubscription(created.id)).toBeNull()
    expect(db.listStatusSubscriptions(page.id)).toEqual([])
  })
})

describe('getDailyUptime', () => {
  let db: Database
  let monitor: MonitorRow

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
    monitor = createPushMonitor(db)
  })

  afterEach(() => {
    db.close()
  })

  /** Seeds `statuses` on the UTC day `dayOffset` days before today, one per minute. */
  function seedDay(dayOffset: number, statuses: HeartbeatStatus[]): void {
    const base = utcDayStart(Date.now()) - dayOffset * DAY_MS
    db.insertHeartbeatsBatch(
      statuses.map((status, index) => ({
        monitorId: monitor.id,
        status,
        time: new Date(base + index * 60_000),
      })),
    )
  }

  it('merges daily rollups with the current day from raw heartbeats', () => {
    const todayStart = utcDayStart(Date.now())
    seedDay(4, ['up', 'up', 'up', 'up', 'down', 'maintenance'])
    const skipped = createPushMonitor(db, 'skipped')
    db.insertHeartbeatsBatch([
      { monitorId: skipped.id, status: 'down', time: new Date(todayStart - 4 * DAY_MS) },
    ])
    seedDay(2, ['up', 'up', 'down', 'down'])
    seedDay(1, ['maintenance'])
    expect(db.rollupHeartbeats(new Date(todayStart))).toBe(12)
    seedDay(0, ['up', 'up', 'up', 'down'])

    const series = db.getDailyUptime(monitor.id, 5)
    expect(series).toHaveLength(5)
    expect(series.map((entry) => entry.date)).toEqual(
      [4, 3, 2, 1, 0].map((offset) => utcDate(todayStart - offset * DAY_MS)),
    )
    expect(series.map((entry) => entry.uptimePct)).toEqual([80, 100, 50, 100, 75])
    expect(series.map((entry) => entry.total)).toEqual([6, 0, 4, 1, 4])
    expect(series.map((entry) => entry.down)).toEqual([1, 0, 2, 0, 1])
    expect(series.map((entry) => entry.maintenance)).toEqual([1, 0, 0, 1, 0])
  })

  it('counts the current day from raw beats even after a rollup absorbs them', () => {
    seedDay(0, ['up', 'down'])
    expect(db.rollupHeartbeats(new Date(utcDayStart(Date.now()) + 3_600_000))).toBe(2)

    const [today] = db.getDailyUptime(monitor.id, 1)
    expect(today).toEqual({
      date: utcDate(utcDayStart(Date.now())),
      uptimePct: 50,
      total: 2,
      down: 1,
      maintenance: 0,
    })
  })

  it('returns the trailing window with empty days at 100 % and no data', () => {
    seedDay(0, ['up'])

    const series = db.getDailyUptime(monitor.id)
    expect(series).toHaveLength(90)
    expect(series.at(-1)?.date).toBe(utcDate(utcDayStart(Date.now())))
    expect(series[0]).toEqual({
      date: utcDate(utcDayStart(Date.now()) - 89 * DAY_MS),
      uptimePct: 100,
      total: 0,
      down: 0,
      maintenance: 0,
    })

    expect(db.getDailyUptime(monitor.id, 0)).toEqual([])
  })
})
