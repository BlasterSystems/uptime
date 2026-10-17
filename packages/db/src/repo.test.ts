import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Database } from './index.js'
import type { MonitorRow } from './index.js'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
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

describe('users', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('creates, reads, updates and deletes users', () => {
    expect(db.countUsers()).toBe(0)

    const created = db.createUser({ email: 'admin@example.com', passwordHash: 'argon2-hash' })
    expect(created).toMatchObject({
      email: 'admin@example.com',
      passwordHash: 'argon2-hash',
      role: 'admin',
      totpEnabled: false,
      totpSecretEnc: null,
      recoveryCodesEnc: null,
    })
    expect(created.createdAt).toBeInstanceOf(Date)
    expect(created.updatedAt).toBeInstanceOf(Date)
    expect(db.countUsers()).toBe(1)

    expect(db.getUserByEmail('admin@example.com')).toEqual(created)
    expect(db.getUserByEmail('other@example.com')).toBeNull()
    expect(db.getUser(created.id)).toEqual(created)
    expect(db.getUser(created.id + 1000)).toBeNull()
    expect(db.listUsers().map((user) => user.id)).toEqual([created.id])

    const updated = db.updateUser(created.id, {
      passwordHash: 'new-hash',
      totpSecretEnc: 'enc-secret',
      totpEnabled: true,
      recoveryCodesEnc: 'enc-codes',
      role: 'viewer',
    })
    expect(updated).toMatchObject({
      id: created.id,
      email: 'admin@example.com',
      passwordHash: 'new-hash',
      totpSecretEnc: 'enc-secret',
      totpEnabled: true,
      recoveryCodesEnc: 'enc-codes',
      role: 'viewer',
    })
    expect(updated?.createdAt).toEqual(created.createdAt)
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())

    // Clearing encrypted fields is a real update, not a no-op.
    const cleared = db.updateUser(created.id, { totpSecretEnc: null, recoveryCodesEnc: null })
    expect(cleared).toMatchObject({
      totpSecretEnc: null,
      recoveryCodesEnc: null,
      totpEnabled: true,
    })

    expect(db.updateUser(created.id + 1000, { role: 'editor' })).toBeNull()

    const second = db.createUser({
      email: 'editor@example.com',
      passwordHash: 'hash',
      role: 'editor',
    })
    expect(second.role).toBe('editor')
    expect(db.listUsers().map((user) => user.email)).toEqual([
      'admin@example.com',
      'editor@example.com',
    ])

    expect(db.deleteUser(second.id)).toBe(true)
    expect(db.deleteUser(second.id)).toBe(false)
    expect(db.countUsers()).toBe(1)
  })

  it('rejects duplicate emails', () => {
    db.createUser({ email: 'dupe@example.com', passwordHash: 'a' })
    expect(() => db.createUser({ email: 'dupe@example.com', passwordHash: 'b' })).toThrow()
  })
})

describe('sessions', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('round-trips generated and explicit session ids', () => {
    const user = db.createUser({ email: 'user@example.com', passwordHash: 'hash' })
    const expiresAt = new Date(Date.now() + 60_000)

    const session = db.createSession({
      userId: user.id,
      csrfToken: 'csrf-token',
      expiresAt,
      ip: '127.0.0.1',
      userAgent: 'vitest',
    })
    expect(session.id).toMatch(/^[0-9a-f]{64}$/)
    expect(session).toMatchObject({
      userId: user.id,
      csrfToken: 'csrf-token',
      ip: '127.0.0.1',
      userAgent: 'vitest',
    })
    expect(session.expiresAt.getTime()).toBe(expiresAt.getTime())
    expect(session.createdAt).toBeInstanceOf(Date)
    expect(db.getSession(session.id)).toEqual(session)

    const explicit = db.createSession({
      id: 'explicit-session-id',
      userId: user.id,
      csrfToken: 'csrf-2',
      expiresAt,
    })
    expect(explicit).toMatchObject({ id: 'explicit-session-id', ip: null, userAgent: null })
    expect(db.getSession('explicit-session-id')?.csrfToken).toBe('csrf-2')

    expect(db.getSession('missing')).toBeNull()
    expect(db.deleteSession('explicit-session-id')).toBe(true)
    expect(db.deleteSession('explicit-session-id')).toBe(false)
    expect(db.getSession('explicit-session-id')).toBeNull()

    // Sessions cascade away with their user.
    expect(db.deleteUser(user.id)).toBe(true)
    expect(db.deleteSession(session.id)).toBe(false)
  })

  it('returns null for an expired session and deletes it', () => {
    const user = db.createUser({ email: 'user@example.com', passwordHash: 'hash' })
    const expired = db.createSession({
      userId: user.id,
      csrfToken: 'csrf',
      expiresAt: new Date(Date.now() - 1000),
    })

    expect(db.getSession(expired.id)).toBeNull()
    // The expired row is gone, not merely hidden.
    expect(db.deleteSession(expired.id)).toBe(false)
  })

  it('prunes only expired sessions', () => {
    const user = db.createUser({ email: 'user@example.com', passwordHash: 'hash' })
    const now = new Date()
    const live = db.createSession({
      userId: user.id,
      csrfToken: 'live',
      expiresAt: new Date(now.getTime() + 60_000),
    })
    const expired = db.createSession({
      userId: user.id,
      csrfToken: 'expired',
      expiresAt: new Date(now.getTime() - 1000),
    })
    db.createSession({
      userId: user.id,
      csrfToken: 'older',
      expiresAt: new Date(now.getTime() - 60_000),
    })

    expect(db.deleteExpiredSessions(now)).toBe(2)
    expect(db.deleteExpiredSessions(now)).toBe(0)
    expect(db.getSession(live.id)).toEqual(live)
    expect(db.deleteSession(expired.id)).toBe(false)
  })
})

describe('api keys', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('round-trips keys, parses scopes and tracks last use', () => {
    const user = db.createUser({ email: 'admin@example.com', passwordHash: 'hash' })
    const keyHash = sha256('secret-key')

    const created = db.createApiKey({
      name: 'ci',
      keyHash,
      scopes: ['read', 'write'],
      createdBy: user.id,
    })
    expect(created).toMatchObject({
      name: 'ci',
      keyHash,
      scopes: ['read', 'write'],
      createdBy: user.id,
      lastUsedAt: null,
      expiresAt: null,
    })
    expect(created.createdAt).toBeInstanceOf(Date)

    expect(db.getApiKeyByKeyHash(keyHash)).toEqual(created)
    expect(db.getApiKeyByKeyHash('unknown-hash')).toBeNull()

    const usedAt = new Date()
    db.touchApiKey(created.id, usedAt)
    expect(db.getApiKeyByKeyHash(keyHash)?.lastUsedAt?.getTime()).toBe(usedAt.getTime())

    const second = db.createApiKey({ name: 'no-owner', keyHash: sha256('other'), scopes: [] })
    expect(second).toMatchObject({ createdBy: null, scopes: [] })
    expect(db.listApiKeys().map((key) => key.id)).toEqual([created.id, second.id])

    expect(db.deleteApiKey(second.id)).toBe(true)
    expect(db.deleteApiKey(second.id)).toBe(false)
    expect(db.getApiKeyByKeyHash(second.keyHash)).toBeNull()
  })

  it('hides expired keys and nulls createdBy when the user is deleted', () => {
    const user = db.createUser({ email: 'admin@example.com', passwordHash: 'hash' })
    const liveHash = sha256('live-key')
    const expiredHash = sha256('expired-key')
    db.createApiKey({
      name: 'live',
      keyHash: liveHash,
      scopes: [],
      createdBy: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const expired = db.createApiKey({
      name: 'expired',
      keyHash: expiredHash,
      scopes: [],
      createdBy: user.id,
      expiresAt: new Date(Date.now() - 1000),
    })

    expect(db.getApiKeyByKeyHash(liveHash)).not.toBeNull()
    expect(db.getApiKeyByKeyHash(expiredHash)).toBeNull()
    expect(db.listApiKeys().map((key) => key.id)).toContain(expired.id)

    expect(db.deleteUser(user.id)).toBe(true)
    expect(db.listApiKeys().map((key) => key.createdBy)).toEqual([null, null])
  })
})

describe('notification channels', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('round-trips channels with defaults and patches updates', () => {
    const created = db.createChannel({ type: 'slack', name: 'ops', configEnc: 'enc:slack' })
    expect(created).toMatchObject({
      type: 'slack',
      name: 'ops',
      configEnc: 'enc:slack',
      isDefault: false,
      active: true,
    })
    expect(created.createdAt.getTime()).toBe(created.updatedAt.getTime())

    const explicit = db.createChannel({
      type: 'email',
      name: 'mail',
      configEnc: 'enc:email',
      isDefault: true,
      active: false,
    })
    expect(explicit).toMatchObject({ isDefault: true, active: false })

    expect(db.listChannels().map((channel) => channel.id)).toEqual([created.id, explicit.id])
    expect(db.getChannel(created.id)).toEqual(created)
    expect(db.getChannel(created.id + 1000)).toBeNull()

    const updated = db.updateChannel(created.id, {
      name: 'ops-renamed',
      configEnc: 'enc:slack-2',
      isDefault: true,
      active: false,
    })
    expect(updated).toMatchObject({
      id: created.id,
      type: 'slack',
      name: 'ops-renamed',
      configEnc: 'enc:slack-2',
      isDefault: true,
      active: false,
    })
    expect(updated?.createdAt).toEqual(created.createdAt)
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())
    expect(db.updateChannel(created.id + 1000, { name: 'nope' })).toBeNull()

    expect(db.deleteChannel(explicit.id)).toBe(true)
    expect(db.deleteChannel(explicit.id)).toBe(false)
    expect(db.getChannel(explicit.id)).toBeNull()
  })
})

describe('monitor-channel routing', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('replaces the monitor channel set and groups lookups', () => {
    const first = createPushMonitor(db, 'first')
    const second = createPushMonitor(db, 'second')
    const a = db.createChannel({ type: 'slack', name: 'a', configEnc: 'enc:a' })
    const b = db.createChannel({ type: 'email', name: 'b', configEnc: 'enc:b' })
    const c = db.createChannel({ type: 'webhook', name: 'c', configEnc: 'enc:c' })

    db.setMonitorChannels(first.id, [a.id, b.id])
    expect(db.listMonitorChannelIds(first.id)).toEqual([a.id, b.id])

    db.setMonitorChannels(first.id, [c.id])
    expect(db.listMonitorChannelIds(first.id)).toEqual([c.id])

    db.setMonitorChannels(second.id, [a.id, c.id])
    expect(db.listChannelIdsForMonitors([first.id, second.id])).toEqual({
      [first.id]: [c.id],
      [second.id]: [a.id, c.id],
    })

    db.setMonitorChannels(first.id, [])
    expect(db.listMonitorChannelIds(first.id)).toEqual([])
    expect(db.listChannelIdsForMonitors([first.id, second.id])).toEqual({
      [first.id]: [],
      [second.id]: [a.id, c.id],
    })
    expect(db.listChannelIdsForMonitors([])).toEqual({})

    // Deleting a channel cascades the routing rows.
    expect(db.deleteChannel(c.id)).toBe(true)
    expect(db.listMonitorChannelIds(first.id)).toEqual([])
    expect(db.listMonitorChannelIds(second.id)).toEqual([a.id])
  })
})

describe('incidents', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('opens at most one incident per monitor and resolves idempotently', () => {
    const first = createPushMonitor(db, 'first')
    const second = createPushMonitor(db, 'second')
    const t1 = new Date('2026-01-01T00:00:00.000Z')
    const t2 = new Date('2026-01-02T00:00:00.000Z')

    const opened = db.openIncident({
      monitorId: first.id,
      openedAt: t1,
      title: 'first is down',
      body: 'connection refused',
    })
    expect(opened).toMatchObject({
      monitorId: first.id,
      openedAt: t1,
      resolvedAt: null,
      title: 'first is down',
      body: 'connection refused',
    })

    const duplicate = db.openIncident({ monitorId: first.id, openedAt: t2, title: 'again' })
    expect(duplicate.id).toBe(opened.id)
    expect(duplicate.openedAt.getTime()).toBe(t1.getTime())
    expect(duplicate.body).toBe('connection refused')

    const other = db.openIncident({ monitorId: second.id, openedAt: t2, title: 'second is down' })
    expect(other).toMatchObject({ monitorId: second.id, body: null })

    expect(db.getOpenIncident(first.id)?.id).toBe(opened.id)
    expect(db.getOpenIncident(second.id)?.id).toBe(other.id)

    const resolvedAt = new Date('2026-01-03T00:00:00.000Z')
    const resolved = db.resolveIncident(opened.id, resolvedAt)
    expect(resolved?.resolvedAt?.getTime()).toBe(resolvedAt.getTime())

    const again = db.resolveIncident(opened.id, new Date('2026-01-04T00:00:00.000Z'))
    expect(again?.resolvedAt?.getTime()).toBe(resolvedAt.getTime())
    expect(db.resolveIncident(opened.id + 1000, resolvedAt)).toBeNull()
    expect(db.getOpenIncident(first.id)).toBeNull()
  })

  it('lists incidents newest first with active/monitor/limit filters', () => {
    const first = createPushMonitor(db, 'first')
    const second = createPushMonitor(db, 'second')
    const t1 = new Date('2026-01-01T00:00:00.000Z')
    const t2 = new Date('2026-01-02T00:00:00.000Z')
    const t3 = new Date('2026-01-03T00:00:00.000Z')

    const oldest = db.openIncident({ monitorId: first.id, openedAt: t1, title: 'one' })
    const middle = db.openIncident({ monitorId: second.id, openedAt: t2, title: 'two' })
    db.resolveIncident(oldest.id, new Date('2026-01-04T00:00:00.000Z'))
    const newest = db.openIncident({ monitorId: first.id, openedAt: t3, title: 'three' })

    expect(db.listIncidents().map((incident) => incident.id)).toEqual([
      newest.id,
      middle.id,
      oldest.id,
    ])
    expect(db.listIncidents({ active: true }).map((incident) => incident.id)).toEqual([
      newest.id,
      middle.id,
    ])
    expect(db.listIncidents({ active: false }).map((incident) => incident.id)).toEqual([oldest.id])
    expect(db.listIncidents({ monitorId: first.id }).map((incident) => incident.id)).toEqual([
      newest.id,
      oldest.id,
    ])
    expect(db.listIncidents({ monitorId: second.id, active: true })).toHaveLength(1)
    expect(db.listIncidents({ limit: 1 }).map((incident) => incident.id)).toEqual([newest.id])
  })
})

describe('tags', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('upserts case-insensitively and keeps the first colour', () => {
    const prod = db.createTag('Prod', '#ff0000')
    expect(prod).toMatchObject({ name: 'Prod', color: '#ff0000' })
    expect(prod.createdAt).toBeInstanceOf(Date)

    const duplicate = db.createTag('prod', '#00ff00')
    expect(duplicate.id).toBe(prod.id)
    expect(duplicate.name).toBe('Prod')
    expect(duplicate.color).toBe('#ff0000')

    const staging = db.createTag('Staging')
    expect(staging.color).toBe('#64748b')
    expect(db.listTags().map((tag) => tag.id)).toEqual([prod.id, staging.id])

    expect(db.deleteTag(staging.id)).toBe(true)
    expect(db.deleteTag(staging.id)).toBe(false)
  })

  it('replaces monitor tags and groups lookups', () => {
    const first = createPushMonitor(db, 'first')
    const second = createPushMonitor(db, 'second')
    const untagged = createPushMonitor(db, 'untagged')
    const prod = db.createTag('prod')
    const staging = db.createTag('staging')
    const canary = db.createTag('canary')

    db.setMonitorTags(first.id, [prod.id, staging.id])
    expect(db.listMonitorTagIds(first.id)).toEqual([prod.id, staging.id])

    db.setMonitorTags(first.id, [canary.id])
    db.setMonitorTags(second.id, [prod.id, canary.id])
    expect(db.listTagIdsForMonitors([first.id, second.id, untagged.id])).toEqual({
      [first.id]: [canary.id],
      [second.id]: [prod.id, canary.id],
      [untagged.id]: [],
    })

    db.setMonitorTags(first.id, [])
    expect(db.listMonitorTagIds(first.id)).toEqual([])
    expect(db.listTagIdsForMonitors([])).toEqual({})

    // Deleting a tag cascades the mapping rows.
    expect(db.deleteTag(canary.id)).toBe(true)
    expect(db.listMonitorTagIds(second.id)).toEqual([prod.id])
    expect(db.listTagIdsForMonitors([first.id])).toEqual({ [first.id]: [] })
  })
})

describe('push token secret storage', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('upserts the encrypted token alongside its hash', () => {
    const monitor = createPushMonitor(db, 'push')
    const other = createPushMonitor(db, 'other')

    expect(db.getPushToken(monitor.id)).toBeNull()

    db.setPushToken(monitor.id, 'raw-token-1', 'enc:1')
    expect(db.getPushToken(monitor.id)).toBe('enc:1')
    expect(db.pushTokenLookup(sha256('raw-token-1'))).toBe(monitor.id)
    expect(db.getPushToken(other.id)).toBeNull()

    // Upsert keeps exactly one row per monitor and rotates both values.
    db.setPushToken(monitor.id, 'raw-token-2', 'enc:2')
    expect(db.getPushToken(monitor.id)).toBe('enc:2')
    expect(db.pushTokenLookup(sha256('raw-token-1'))).toBeNull()
    expect(db.pushTokenLookup(sha256('raw-token-2'))).toBe(monitor.id)

    // Hash-only rotation (createPushToken) clears the encrypted copy.
    const rotated = db.createPushToken(monitor.id)
    expect(db.getPushToken(monitor.id)).toBeNull()
    expect(db.pushTokenLookup(sha256(rotated))).toBe(monitor.id)

    // Cascades with the monitor.
    expect(db.deleteMonitor(monitor.id)).toBe(true)
    expect(db.getPushToken(monitor.id)).toBeNull()
  })
})

describe('listActivePushMonitors', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('returns active push monitors with their latest heartbeat time', () => {
    const push = createPushMonitor(db, 'push')
    const never = createPushMonitor(db, 'never-probed')
    const inactive = createPushMonitor(db, 'inactive')
    db.updateMonitor(inactive.id, { active: false })
    const http = db.createMonitor({
      type: 'http',
      name: 'http',
      intervalS: 60,
      retries: 1,
      retryIntervalS: 60,
      config: {},
    })

    const t1 = new Date('2026-02-01T00:00:00.000Z')
    const t2 = new Date('2026-02-01T00:05:00.000Z')
    db.insertHeartbeat({ monitorId: push.id, status: 'up', time: t1 })
    db.insertHeartbeat({ monitorId: push.id, status: 'down', time: t2 })
    db.insertHeartbeat({ monitorId: inactive.id, status: 'up', time: t2 })
    db.insertHeartbeat({ monitorId: http.id, status: 'up', time: t2 })

    const rows = db.listActivePushMonitors()
    expect(rows.map((row) => row.monitor.id)).toEqual([push.id, never.id])
    expect(rows[0]?.monitor.name).toBe('push')
    expect(rows[0]?.monitor.type).toBe('push')
    expect(rows[0]?.monitor.config).toEqual({})
    expect(rows[0]?.monitor.createdAt).toBeInstanceOf(Date)
    expect(rows[0]?.lastBeatAt?.getTime()).toBe(t2.getTime())
    expect(rows[1]?.monitor.name).toBe('never-probed')
    expect(rows[1]?.lastBeatAt).toBeNull()
  })
})

describe('status pages', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('creates with defaults and round-trips parsed fields', () => {
    const created = db.createStatusPage({ slug: 'status', title: 'Status' })
    expect(created.id).toBeGreaterThan(0)
    expect(created).toMatchObject({
      slug: 'status',
      title: 'Status',
      logo: null,
      published: false,
      monitorIds: [],
      theme: null,
    })
    expect(created.createdAt).toBeInstanceOf(Date)
    expect(created.updatedAt).toBeInstanceOf(Date)

    const themed = db.createStatusPage({
      slug: 'themed',
      title: 'Themed',
      logo: 'https://example.com/logo.svg',
      published: true,
      monitorIds: [1, 2, 3],
      theme: { accent: '#0ea5e9', dark: 'auto' },
    })
    expect(themed).toMatchObject({
      logo: 'https://example.com/logo.svg',
      published: true,
      monitorIds: [1, 2, 3],
      theme: { accent: '#0ea5e9', dark: 'auto' },
    })

    expect(db.getStatusPage(created.id)).toEqual(created)
    expect(db.getStatusPage(created.id + 1000)).toBeNull()
    expect(db.listStatusPages().map((page) => page.slug)).toEqual(['status', 'themed'])
  })

  it('rejects duplicate slugs on create and update', () => {
    db.createStatusPage({ slug: 'status', title: 'Status' })
    expect(() => db.createStatusPage({ slug: 'status', title: 'Other' })).toThrow()

    const other = db.createStatusPage({ slug: 'other', title: 'Other' })
    expect(() => db.updateStatusPage(other.id, { slug: 'status' })).toThrow()
    expect(db.getStatusPage(other.id)?.slug).toBe('other')
  })

  it('serves only published pages publicly', () => {
    const draft = db.createStatusPage({ slug: 'draft', title: 'Draft' })
    const live = db.createStatusPage({ slug: 'live', title: 'Live', published: true })

    expect(db.getPublicStatusPage('draft')).toBeNull()
    expect(db.getPublicStatusPage('missing')).toBeNull()
    expect(db.getPublicStatusPage('live')?.id).toBe(live.id)

    const published = db.updateStatusPage(draft.id, { published: true })
    expect(published?.published).toBe(true)
    expect(db.getPublicStatusPage('draft')?.id).toBe(draft.id)
  })

  it('patches provided fields, clears nullable ones and deletes', () => {
    const created = db.createStatusPage({
      slug: 'status',
      title: 'Status',
      logo: 'logo.svg',
      monitorIds: [1],
      theme: { accent: '#ffffff' },
    })

    const updated = db.updateStatusPage(created.id, {
      title: 'Renamed',
      logo: null,
      monitorIds: [2, 3],
      theme: null,
    })
    expect(updated).toMatchObject({
      id: created.id,
      slug: 'status',
      title: 'Renamed',
      logo: null,
      published: false,
      monitorIds: [2, 3],
      theme: null,
    })
    expect(updated?.createdAt).toEqual(created.createdAt)
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())

    expect(db.updateStatusPage(created.id + 1000, { title: 'nope' })).toBeNull()
    expect(db.deleteStatusPage(created.id)).toBe(true)
    expect(db.deleteStatusPage(created.id)).toBe(false)
    expect(db.getStatusPage(created.id)).toBeNull()
  })
})

describe('maintenance windows', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('creates single and recurring windows with their defaults', () => {
    const single = db.createMaintenanceWindow({
      name: 'Upgrade',
      scope: 'all',
      strategy: 'single',
      startAt: new Date('2026-03-01T01:00:00.000Z'),
      endAt: new Date('2026-03-01T03:00:00.000Z'),
    })
    expect(single).toMatchObject({
      name: 'Upgrade',
      scope: 'all',
      monitorIds: [],
      tagIds: [],
      strategy: 'single',
      intervalS: null,
      weekdays: null,
      startTime: null,
      endTime: null,
      cronExpr: null,
      cronTz: null,
      active: true,
    })
    expect(single.startAt?.getTime()).toBe(Date.parse('2026-03-01T01:00:00.000Z'))
    expect(single.endAt?.getTime()).toBe(Date.parse('2026-03-01T03:00:00.000Z'))
    expect(single.createdAt).toBeInstanceOf(Date)
    expect(single.updatedAt).toBeInstanceOf(Date)

    const recurring = db.createMaintenanceWindow({
      name: 'Nightly',
      scope: 'ids',
      monitorIds: [1, 2],
      tagIds: [9],
      strategy: 'recurring-weekday',
      weekdays: [1, 3, 5],
      startTime: '22:30',
      endTime: '23:45',
      cronExpr: '30 22 * * 1,3,5',
      cronTz: 'Europe/Lisbon',
      active: false,
    })
    expect(recurring).toMatchObject({
      name: 'Nightly',
      scope: 'ids',
      monitorIds: [1, 2],
      tagIds: [9],
      strategy: 'recurring-weekday',
      weekdays: [1, 3, 5],
      startTime: '22:30',
      endTime: '23:45',
      cronExpr: '30 22 * * 1,3,5',
      cronTz: 'Europe/Lisbon',
      active: false,
      startAt: null,
      endAt: null,
      intervalS: null,
    })

    const interval = db.createMaintenanceWindow({
      name: 'Every six hours',
      scope: 'tags',
      tagIds: [4],
      strategy: 'recurring-interval',
      intervalS: 21_600,
      startTime: '00:00',
      endTime: '01:00',
    })
    expect(interval).toMatchObject({ scope: 'tags', intervalS: 21_600, startTime: '00:00' })

    expect(db.listMaintenanceWindows().map((window) => window.name)).toEqual([
      'Upgrade',
      'Nightly',
      'Every six hours',
    ])
  })

  it('patches provided fields, clears nullable ones and deletes', () => {
    const created = db.createMaintenanceWindow({
      name: 'Upgrade',
      scope: 'all',
      strategy: 'single',
      startAt: new Date('2026-03-01T01:00:00.000Z'),
      endAt: new Date('2026-03-01T03:00:00.000Z'),
    })

    const updated = db.updateMaintenanceWindow(created.id, {
      name: 'Renamed',
      scope: 'tags',
      tagIds: [7],
      strategy: 'cron',
      startAt: null,
      endAt: null,
      cronExpr: '0 3 * * *',
      active: false,
    })
    expect(updated).toMatchObject({
      id: created.id,
      name: 'Renamed',
      scope: 'tags',
      tagIds: [7],
      monitorIds: [],
      strategy: 'cron',
      startAt: null,
      endAt: null,
      cronExpr: '0 3 * * *',
      active: false,
    })
    expect(updated?.createdAt).toEqual(created.createdAt)
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())

    expect(db.updateMaintenanceWindow(created.id + 1000, { name: 'nope' })).toBeNull()
    expect(db.deleteMaintenanceWindow(created.id)).toBe(true)
    expect(db.deleteMaintenanceWindow(created.id)).toBe(false)
    expect(db.listMaintenanceWindows()).toEqual([])
  })
})

describe('heartbeat rollups', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('aggregates hourly and daily counters, advances the watermark and reruns safely', () => {
    const monitor = createPushMonitor(db, 'rolled')
    const other = createPushMonitor(db, 'other')
    const now = Date.now()

    db.insertHeartbeat({
      monitorId: monitor.id,
      status: 'up',
      latencyMs: 10,
      time: new Date(now - 90 * 60_000),
    })
    db.insertHeartbeat({
      monitorId: monitor.id,
      status: 'down',
      latencyMs: 30,
      time: new Date(now - 85 * 60_000),
    })
    db.insertHeartbeat({ monitorId: monitor.id, status: 'up', time: new Date(now - 10 * 60_000) })
    db.insertHeartbeat({
      monitorId: monitor.id,
      status: 'maintenance',
      time: new Date(now - 5 * 60_000),
    })
    db.insertHeartbeat({ monitorId: other.id, status: 'up', time: new Date(now - 5 * 60_000) })

    const before = new Date(now + 1000)
    expect(db.rollupHeartbeats(before)).toBe(5)
    expect(db.getSetting('rollup_watermark')).toBe(String(before.getTime()))

    const stats = db.getUptime(monitor.id, 24)
    expect(stats.total).toBe(4)
    expect(stats.up).toBe(2)
    expect(stats.down).toBe(1)
    expect(stats.maintenance).toBe(1)
    expect(stats.uptimePct).toBeCloseTo((2 / 3) * 100)
    expect(db.getUptime(other.id, 24)).toEqual({
      total: 1,
      up: 1,
      down: 0,
      maintenance: 0,
      uptimePct: 100,
    })

    // Rerunning with the same horizon is a no-op with unchanged counters.
    expect(db.rollupHeartbeats(before)).toBe(0)
    expect(db.getUptime(monitor.id, 24)).toEqual(stats)
    expect(db.getSetting('rollup_watermark')).toBe(String(before.getTime()))

    // Only the window after the watermark is processed.
    db.insertHeartbeat({ monitorId: monitor.id, status: 'down', time: new Date(now + 2000) })
    const later = new Date(now + 10_000)
    expect(db.rollupHeartbeats(later)).toBe(1)
    expect(db.getSetting('rollup_watermark')).toBe(String(later.getTime()))
    expect(db.getUptime(monitor.id, 24)).toEqual({
      total: 5,
      up: 2,
      down: 2,
      maintenance: 1,
      uptimePct: 50,
    })
  })

  it('accumulates partial buckets without double counting', () => {
    const monitor = createPushMonitor(db, 'partial')
    const now = Date.now()
    const hourStart = Math.floor((now - 2 * 3_600_000) / 3_600_000) * 3_600_000
    db.insertHeartbeat({
      monitorId: monitor.id,
      status: 'up',
      latencyMs: 10,
      time: new Date(hourStart + 1000),
    })
    db.insertHeartbeat({
      monitorId: monitor.id,
      status: 'down',
      latencyMs: 20,
      time: new Date(hourStart + 2000),
    })
    db.insertHeartbeat({
      monitorId: monitor.id,
      status: 'up',
      latencyMs: 30,
      time: new Date(hourStart + 3000),
    })

    expect(db.rollupHeartbeats(new Date(hourStart + 2000))).toBe(1)
    expect(db.getUptime(monitor.id, 24)).toMatchObject({ total: 1, up: 1, down: 0 })

    expect(db.rollupHeartbeats(new Date(hourStart + 4000))).toBe(2)
    const stats = db.getUptime(monitor.id, 24)
    expect(stats.total).toBe(3)
    expect(stats.up).toBe(2)
    expect(stats.down).toBe(1)
    expect(stats.uptimePct).toBeCloseTo((2 / 3) * 100)
    // The daily counters accumulate across the same partial runs.
    expect(db.getUptime(monitor.id, 720).total).toBe(3)

    expect(db.rollupHeartbeats(new Date(hourStart + 4000))).toBe(0)
    expect(db.getUptime(monitor.id, 24)).toEqual(stats)
  })

  it('serves the 7-day window from daily counters', () => {
    const monitor = createPushMonitor(db, 'daily')
    const now = Date.now()
    const day = 86_400_000
    db.insertHeartbeat({ monitorId: monitor.id, status: 'up', time: new Date(now - 2 * day) })
    db.insertHeartbeat({
      monitorId: monitor.id,
      status: 'down',
      latencyMs: 40,
      time: new Date(now - day),
    })
    db.insertHeartbeat({ monitorId: monitor.id, status: 'up', time: new Date(now - 10 * day) })

    expect(db.rollupHeartbeats(new Date(now + 1000))).toBe(3)

    const stats = db.getUptime(monitor.id, 168)
    expect(stats).toEqual({ total: 2, up: 1, down: 1, maintenance: 0, uptimePct: 50 })
    // The hourly path sees the same 7-day slice only.
    expect(db.getUptime(monitor.id, 24).total).toBe(0)
  })

  it('reports 100% with no data and ignores rows already rolled up', () => {
    const monitor = createPushMonitor(db, 'empty')
    expect(db.getUptime(monitor.id, 24)).toEqual({
      total: 0,
      up: 0,
      down: 0,
      maintenance: 0,
      uptimePct: 100,
    })
    expect(db.rollupHeartbeats(new Date())).toBe(0)
    expect(db.getSetting('rollup_watermark')).not.toBeNull()
    expect(db.getUptime(monitor.id, 720)).toEqual({
      total: 0,
      up: 0,
      down: 0,
      maintenance: 0,
      uptimePct: 100,
    })
  })
})

describe('listHeartbeatsSince', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('returns the window oldest first, scoped to the monitor and limited', () => {
    const monitor = createPushMonitor(db, 'since')
    const other = createPushMonitor(db, 'other')
    const base = Date.UTC(2026, 1, 1)
    const times = [base, base + 60_000, base + 120_000, base + 180_000]
    for (const ms of times) {
      db.insertHeartbeat({ monitorId: monitor.id, status: 'up', time: new Date(ms) })
    }
    db.insertHeartbeat({ monitorId: other.id, status: 'down', time: new Date(base + 60_000) })

    expect(db.listHeartbeatsSince(monitor.id, new Date(base)).map((h) => h.time.getTime())).toEqual(
      times,
    )
    expect(
      db.listHeartbeatsSince(monitor.id, new Date(base + 60_000)).map((h) => h.time.getTime()),
    ).toEqual(times.slice(1))
    expect(
      db.listHeartbeatsSince(monitor.id, new Date(base), 2).map((h) => h.time.getTime()),
    ).toEqual(times.slice(0, 2))
    expect(db.listHeartbeatsSince(monitor.id, new Date(base + 10_000_000))).toEqual([])
    expect(db.listHeartbeatsSince(other.id, new Date(base))).toHaveLength(1)
  })
})

describe('monitor isPublic', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('defaults to private and persists an explicit public flag', () => {
    const implicit = createPushMonitor(db, 'implicit')
    expect(implicit.isPublic).toBe(false)

    const explicit = db.createMonitor({
      type: 'push',
      name: 'explicit',
      intervalS: 60,
      retries: 1,
      retryIntervalS: 60,
      isPublic: true,
      config: {},
    })
    expect(explicit.isPublic).toBe(true)
    expect(db.getMonitor(explicit.id)?.isPublic).toBe(true)
  })

  it('toggles isPublic through updateMonitor without touching other fields', () => {
    const monitor = createPushMonitor(db, 'toggle')
    expect(monitor.isPublic).toBe(false)

    const published = db.updateMonitor(monitor.id, { isPublic: true })
    expect(published).toMatchObject({ id: monitor.id, name: 'toggle', isPublic: true })

    const withdrawn = db.updateMonitor(monitor.id, { isPublic: false })
    expect(withdrawn).toMatchObject({ id: monitor.id, isPublic: false })
  })
})

describe('password reset tokens', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db?.close()
  })

  it('stores only the hash and replaces outstanding tokens', () => {
    const user = db.createUser({ email: 'a@b.c', passwordHash: 'h' })
    db.createPasswordResetToken({
      userId: user.id,
      rawToken: 'tok-1',
      expiresAt: new Date(Date.now() + 60_000),
    })
    db.createPasswordResetToken({
      userId: user.id,
      rawToken: 'tok-2',
      expiresAt: new Date(Date.now() + 60_000),
    })

    const valid = db.getValidPasswordResetToken('tok-2')
    expect(valid).not.toBeNull()
    expect(valid?.tokenHash).toBe(sha256('tok-2'))
    expect(valid?.userId).toBe(user.id)
    expect(valid?.usedAt).toBeNull()
    expect(db.getValidPasswordResetToken('tok-1')).toBeNull()
  })

  it('rejects expired and used tokens', () => {
    const user = db.createUser({ email: 'a@b.c', passwordHash: 'h' })
    db.createPasswordResetToken({
      userId: user.id,
      rawToken: 'old',
      expiresAt: new Date(Date.now() - 1_000),
    })
    expect(db.getValidPasswordResetToken('old')).toBeNull()

    db.createPasswordResetToken({
      userId: user.id,
      rawToken: 'fresh',
      expiresAt: new Date(Date.now() + 60_000),
    })
    const row = db.getValidPasswordResetToken('fresh')
    expect(row).not.toBeNull()
    db.markPasswordResetTokenUsed(row!.id, new Date())
    expect(db.getValidPasswordResetToken('fresh')).toBeNull()
    expect(db.getValidPasswordResetToken('unknown')).toBeNull()
  })

  it('deletes tokens per user without touching other users', () => {
    const a = db.createUser({ email: 'a@b.c', passwordHash: 'h' })
    const b = db.createUser({ email: 'd@e.f', passwordHash: 'h' })
    db.createPasswordResetToken({
      userId: a.id,
      rawToken: 'ta',
      expiresAt: new Date(Date.now() + 60_000),
    })
    db.createPasswordResetToken({
      userId: b.id,
      rawToken: 'tb',
      expiresAt: new Date(Date.now() + 60_000),
    })
    db.deletePasswordResetTokensForUser(a.id)
    expect(db.getValidPasswordResetToken('ta')).toBeNull()
    expect(db.getValidPasswordResetToken('tb')).not.toBeNull()
  })
})

describe('mailer settings', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db?.close()
  })

  it('creates the singleton on first access and patches it', () => {
    const initial = db.getMailerSettings()
    expect(initial.provider).toBe('resend')
    expect(initial.apiKeyEnc).toBeNull()
    expect(initial.fromAddress).toBeNull()
    expect(initial.enabled).toBe(false)
    expect(db.getMailerSettings().id).toBe(initial.id)

    const updated = db.updateMailerSettings({
      apiKeyEnc: 'v1:enc',
      fromAddress: 'uptime@example.com',
      enabled: true,
    })
    expect(updated.apiKeyEnc).toBe('v1:enc')
    expect(updated.fromAddress).toBe('uptime@example.com')
    expect(updated.enabled).toBe(true)
    expect(db.getMailerSettings().apiKeyEnc).toBe('v1:enc')

    // Clearing the key leaves the other fields alone.
    const cleared = db.updateMailerSettings({ apiKeyEnc: null })
    expect(cleared.apiKeyEnc).toBeNull()
    expect(cleared.enabled).toBe(true)
    expect(cleared.fromAddress).toBe('uptime@example.com')
  })
})
