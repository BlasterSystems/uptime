import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Agent } from 'supertest'
import type { Express } from 'express'
import { Database, SecretBox } from '@uptime/db'
import { Notifier } from '@uptime/notify'
import { createApp } from './app.js'
import { createAuthModule } from './auth/index.js'
import { Metrics } from './metrics.js'

const KEY = 'a'.repeat(64)

function makeApp() {
  const db = Database.open({ file: ':memory:' })
  const secrets = new SecretBox(KEY)
  const app = createApp({
    db,
    secrets,
    notifier: new Notifier({ channels: () => [], monitorChannelIds: () => [], defaultChannelIds: () => [] }),
    auth: createAuthModule({ db, secrets }),
    metrics: new Metrics(),
  })
  return { db, app }
}

async function authed(app: Express): Promise<{ agent: Agent; csrf: string }> {
  const agent = request.agent(app)
  const res = await agent.post('/api/v1/auth/setup').send({ email: 'admin@example.com', password: 'password123' })
  expect(res.status).toBe(200)
  return { agent, csrf: res.body.csrfToken as string }
}

describe('user management', () => {
  let app: Express
  let db: Database

  beforeEach(() => {
    const ctx = makeApp()
    app = ctx.app
    db = ctx.db
  })

  afterEach(() => {
    db.close()
  })

  it('creates, lists, edits and deletes users as admin', async () => {
    const { agent, csrf } = await authed(app)

    const created = await agent
      .post('/api/v1/users')
      .set('x-csrf-token', csrf)
      .send({ email: 'viewer@example.com', password: 'viewer-pass-1', role: 'viewer' })
    expect(created.status).toBe(201)
    expect(created.body.user).toMatchObject({ email: 'viewer@example.com', role: 'viewer', totpEnabled: false })
    expect(created.body.user).not.toHaveProperty('passwordHash')

    const listed = await agent.get('/api/v1/users')
    expect(listed.status).toBe(200)
    expect(listed.body.users.map((u: { email: string }) => u.email)).toEqual([
      'admin@example.com',
      'viewer@example.com',
    ])

    const patched = await agent
      .patch(`/api/v1/users/${created.body.user.id}`)
      .set('x-csrf-token', csrf)
      .send({ role: 'editor' })
    expect(patched.status).toBe(200)
    expect(patched.body.user.role).toBe('editor')

    const deleted = await agent
      .delete(`/api/v1/users/${created.body.user.id}`)
      .set('x-csrf-token', csrf)
    expect(deleted.status).toBe(204)
    expect((await agent.get('/api/v1/users')).body.users).toHaveLength(1)
  })

  it('rejects invalid input and duplicate emails', async () => {
    const { agent, csrf } = await authed(app)

    expect(
      (
        await agent
          .post('/api/v1/users')
          .set('x-csrf-token', csrf)
          .send({ email: 'not-an-email', password: 'viewer-pass-1', role: 'viewer' })
      ).status,
    ).toBe(400)
    expect(
      (
        await agent
          .post('/api/v1/users')
          .set('x-csrf-token', csrf)
          .send({ email: 'x@example.com', password: 'short', role: 'viewer' })
      ).status,
    ).toBe(400)
    expect(
      (
        await agent
          .post('/api/v1/users')
          .set('x-csrf-token', csrf)
          .send({ email: 'x@example.com', password: 'viewer-pass-1', role: 'root' })
      ).status,
    ).toBe(400)

    expect(
      (
        await agent
          .post('/api/v1/users')
          .set('x-csrf-token', csrf)
          .send({ email: 'admin@example.com', password: 'viewer-pass-1', role: 'viewer' })
      ).status,
    ).toBe(409)
  })

  it('never lets an instance lose its last admin', async () => {
    const { agent, csrf } = await authed(app)

    // The setup admin is the only admin: demotion is refused, and deleting it
    // is refused as a self-delete (the caller would be the last admin).
    expect(
      (await agent.patch('/api/v1/users/1').set('x-csrf-token', csrf).send({ role: 'viewer' }))
        .status,
    ).toBe(409)
    expect((await agent.delete('/api/v1/users/1').set('x-csrf-token', csrf)).status).toBe(400)

    const secondAdmin = await agent
      .post('/api/v1/users')
      .set('x-csrf-token', csrf)
      .send({ email: 'second@example.com', password: 'viewer-pass-1', role: 'admin' })
    const secondId = secondAdmin.body.user.id

    // With two admins, demotion and deletion of the other admin are fine.
    expect(
      (await agent.patch(`/api/v1/users/${secondId}`).set('x-csrf-token', csrf).send({ role: 'viewer' }))
        .status,
    ).toBe(200)
    expect((await agent.delete(`/api/v1/users/${secondId}`).set('x-csrf-token', csrf)).status).toBe(204)

    // Back to a single admin: the guard applies again.
    expect(
      (await agent.patch('/api/v1/users/1').set('x-csrf-token', csrf).send({ role: 'viewer' }))
        .status,
    ).toBe(409)
  })

  it('refuses to delete the caller and locks viewers out', async () => {
    const { agent, csrf } = await authed(app)
    const viewerAgent = request.agent(app)
    await viewerAgent
      .post('/api/v1/auth/login')
      .send({ email: 'admin@example.com', password: 'password123' })

    // The setup admin is user 1; deleting yourself is refused.
    expect(
      (await agent.delete('/api/v1/users/1').set('x-csrf-token', csrf)).status,
    ).toBe(400)

    // A viewer session cannot manage users at all.
    await agent
      .post('/api/v1/users')
      .set('x-csrf-token', csrf)
      .send({ email: 'viewer@example.com', password: 'viewer-pass-1', role: 'viewer' })
    const viewerLogin = await viewerAgent
      .post('/api/v1/auth/login')
      .send({ email: 'viewer@example.com', password: 'viewer-pass-1' })
    expect(viewerLogin.status).toBe(200)
    expect((await viewerAgent.get('/api/v1/users')).status).toBe(403)
  })

  it('changes the password and signs other sessions out', async () => {
    const first = await authed(app)
    const secondAgent = request.agent(app)
    await secondAgent
      .post('/api/v1/auth/login')
      .send({ email: 'admin@example.com', password: 'password123' })

    expect(
      (
        await first.agent
          .post('/api/v1/auth/change-password')
          .set('x-csrf-token', first.csrf)
          .send({ currentPassword: 'wrong-password', nextPassword: 'new-password-9' })
      ).status,
    ).toBe(401)

    expect(
      (
        await first.agent
          .post('/api/v1/auth/change-password')
          .set('x-csrf-token', first.csrf)
          .send({ currentPassword: 'password123', nextPassword: 'short' })
      ).status,
    ).toBe(400)

    expect(
      (
        await first.agent
          .post('/api/v1/auth/change-password')
          .set('x-csrf-token', first.csrf)
          .send({ currentPassword: 'password123', nextPassword: 'new-password-9' })
      ).status,
    ).toBe(204)

    // The old password no longer logs in; the new one does.
    expect(
      (await request(app).post('/api/v1/auth/login').send({ email: 'admin@example.com', password: 'password123' }))
        .status,
    ).toBe(401)
    expect(
      (await request(app).post('/api/v1/auth/login').send({ email: 'admin@example.com', password: 'new-password-9' }))
        .status,
    ).toBe(200)

    // The other session was revoked; the caller's session survives.
    expect((await secondAgent.get('/api/v1/auth/me')).status).toBe(401)
    expect((await first.agent.get('/api/v1/auth/me')).status).toBe(200)
  })
})
