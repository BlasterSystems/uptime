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
