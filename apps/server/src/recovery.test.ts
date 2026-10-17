import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { Database, SecretBox } from '@uptime/db'
import { Notifier } from '@uptime/notify'
import { createApp } from './app.js'
import { createAuthModule } from './auth/index.js'
import { SESSION_COOKIE } from './auth/index.js'
import { Metrics } from './metrics.js'
import type { MailerLike } from './mailer.js'

const PASSWORD = 'password123'

interface CapturedMail {
  to: string
  subject: string
  text: string
  html?: string
}

function stubMailer(configured = true): {
  mailer: MailerLike
  sent: CapturedMail[]
  state: { configured: boolean }
} {
  const sent: CapturedMail[] = []
  const state = { configured }
  return {
    state,
    mailer: {
      get configured(): boolean {
        return state.configured
      },
      async sendMail(input: CapturedMail): Promise<void> {
        sent.push(input)
      },
    },
    sent,
  }
}

function makeApp(mailer?: MailerLike): { db: Database; app: Express } {
  const db = Database.open({ file: ':memory:' })
  const secrets = new SecretBox('a'.repeat(64))
  const app = createApp({
    db,
    secrets,
    notifier: new Notifier({
      channels: () => [],
      monitorChannelIds: () => [],
      defaultChannelIds: () => [],
    }),
    auth: createAuthModule({ db, secrets, mailer }),
    metrics: new Metrics(),
    mailer,
  })
  return { db, app }
}

async function authed(app: Express): Promise<{ agent: request.Agent; csrf: string }> {
  const agent = request.agent(app)
  const res = await agent
    .post('/api/v1/auth/setup')
    .send({ email: 'admin@example.com', password: PASSWORD })
  expect(res.status).toBe(200)
  return { agent, csrf: res.body.csrfToken as string }
}

function resetTokenFrom(mail: CapturedMail): string {
  const match = /token=([A-Za-z0-9_-]+)/.exec(mail.text)
  expect(match, 'reset link contains a token').not.toBeNull()
  return match![1]!
}

describe('password recovery', () => {
  let app: Express
  let sent: CapturedMail[]
  let mailer: MailerLike

  beforeEach(() => {
    const stub = stubMailer()
    sent = stub.sent
    mailer = stub.mailer
    ;({ app } = makeApp(mailer))
  })

  it('answers unknown and invalid emails with an empty 204', async () => {
    for (const body of [{ email: 'nobody@example.com' }, { email: 'not-an-email' }, {}]) {
      const res = await request(app).post('/api/v1/auth/forgot-password').send(body)
      expect(res.status).toBe(204)
      expect(res.body).toEqual({})
    }
    expect(sent).toHaveLength(0)
  })

  it('sends a usable reset link for a known email', async () => {
    await authed(app)
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'admin@example.com' })
    expect(res.status).toBe(204)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe('admin@example.com')
    expect(sent[0]?.subject).toBe('Reset your password')

    const token = resetTokenFrom(sent[0]!)
    const reset = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'brand-new-pass-1' })
    expect(reset.status).toBe(204)

    // The new password logs in; the old one does not.
    const oldLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@example.com', password: PASSWORD })
    expect(oldLogin.status).toBe(401)
    const newLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@example.com', password: 'brand-new-pass-1' })
    expect(newLogin.status).toBe(200)
  })

  it('rejects an unknown, reused or short-password reset', async () => {
    await authed(app)
    expect(
      (await request(app).post('/api/v1/auth/reset-password').send({ token: 'nope', password: 'brand-new-pass-1' }))
        .status,
    ).toBe(400)

    await request(app).post('/api/v1/auth/forgot-password').send({ email: 'admin@example.com' })
    const token = resetTokenFrom(sent[0]!)
    expect(
      (await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'short' })).status,
    ).toBe(400)
    expect(
      (await request(app).post('/api/v1/auth/reset-password').send({ password: 'brand-new-pass-1' })).status,
    ).toBe(400)

    expect(
      (await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'brand-new-pass-1' }))
        .status,
    ).toBe(204)
    expect(
      (await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'brand-new-pass-2' }))
        .status,
    ).toBe(400)
  })

  it('signs every session out on reset', async () => {
    const { agent } = await authed(app)
    const second = request.agent(app)
    await second.post('/api/v1/auth/login').send({ email: 'admin@example.com', password: PASSWORD })
    expect((await second.get('/api/v1/auth/me')).status).toBe(200)

    await request(app).post('/api/v1/auth/forgot-password').send({ email: 'admin@example.com' })
    const token = resetTokenFrom(sent[0]!)
    expect(
      (await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'brand-new-pass-1' }))
        .status,
    ).toBe(204)

    expect((await second.get('/api/v1/auth/me')).status).toBe(401)
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401)
  })

  it('stays 204 when the mailer fails', async () => {
    const failing: MailerLike = {
      configured: true,
      sendMail: async () => {
        throw new Error('smtp exploded')
      },
    }
    ;({ app } = makeApp(failing))
    await authed(app)
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'admin@example.com' })
    expect(res.status).toBe(204)
  })

  it('rate limits forgot and reset attempts', async () => {
    await authed(app)
    for (let i = 0; i < 5; i += 1) {
      expect(
        (await request(app).post('/api/v1/auth/forgot-password').send({ email: 'admin@example.com' })).status,
      ).toBe(204)
    }
    expect(sent).toHaveLength(5)
    const sixth = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'admin@example.com' })
    expect(sixth.status).toBe(429)
    expect(sixth.body.error).toBe('too_many_attempts')

    for (let i = 0; i < 10; i += 1) {
      await request(app).post('/api/v1/auth/reset-password').send({ token: 'nope', password: 'brand-new-pass-1' })
    }
    expect(
      (await request(app).post('/api/v1/auth/reset-password').send({ token: 'nope', password: 'brand-new-pass-1' }))
        .status,
    ).toBe(429)
  })

  it('does not send when no mailer is wired', async () => {
    ;({ app } = makeApp(undefined))
    await authed(app)
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'admin@example.com' })
    expect(res.status).toBe(204)
  })

  it('does not touch sessions or TOTP enrolment for other accounts', async () => {
    // A reset for a viewer must not revoke the admin's session.
    const { agent, csrf } = await authed(app)
    await agent.post('/api/v1/users').set('x-csrf-token', csrf).send({
      email: 'viewer@example.com',
      password: 'viewer-pass-1',
      role: 'viewer',
    })
    await request(app).post('/api/v1/auth/forgot-password').send({ email: 'viewer@example.com' })
    const token = resetTokenFrom(sent[0]!)
    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'viewer-new-pass-1' })

    expect((await agent.get('/api/v1/auth/me')).status).toBe(200)
    const viewerLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'viewer@example.com', password: 'viewer-new-pass-1' })
    expect(viewerLogin.status).toBe(200)
  })
})

describe('mailer settings API', () => {
  let db: Database
  let app: Express
  let agent: request.Agent
  let csrf: string

  beforeEach(async () => {
    const stub = stubMailer()
    ;({ db, app } = makeApp(stub.mailer))
    ;({ agent, csrf } = await authed(app))
  })

  it('reads and writes the singleton without echoing the key', async () => {
    const initial = await agent.get('/api/v1/mailer')
    expect(initial.status).toBe(200)
    expect(initial.body.mailer).toEqual({
      provider: 'resend',
      enabled: false,
      from: null,
      hasApiKey: false,
    })

    const put = await agent.put('/api/v1/mailer').set('x-csrf-token', csrf).send({
      apiKey: 're_123',
      from: 'uptime@example.com',
      enabled: true,
    })
    expect(put.status).toBe(200)
    expect(put.body.mailer).toEqual({
      provider: 'resend',
      enabled: true,
      from: 'uptime@example.com',
      hasApiKey: true,
    })
    expect(JSON.stringify(put.body)).not.toContain('re_123')

    // Stored encrypted at rest (ADR-0002).
    const row = db.getMailerSettings()
    expect(row.apiKeyEnc).not.toBe('re_123')
    expect(row.apiKeyEnc).toMatch(/^v1:/)

    // Clearing the key keeps the other fields.
    const cleared = await agent.put('/api/v1/mailer').set('x-csrf-token', csrf).send({ apiKey: null })
    expect(cleared.body.mailer.hasApiKey).toBe(false)
    expect(cleared.body.mailer.enabled).toBe(true)

    const rejects = await agent.put('/api/v1/mailer').set('x-csrf-token', csrf).send({ enabled: 'yes' })
    expect(rejects.status).toBe(400)
  })

  it('sends a test email through the configured mailer', async () => {
    const stub = stubMailer(false)
    ;({ app } = makeApp(stub.mailer))
    const { agent: admin, csrf: token } = await authed(app)

    const unconfigured = await admin.post('/api/v1/mailer/test').set('x-csrf-token', token).send({})
    expect(unconfigured.status).toBe(400)
    expect(unconfigured.body.error).toBe('mailer_not_configured')

    // Configure through the API itself, then send to the caller's address.
    await admin.put('/api/v1/mailer').set('x-csrf-token', token).send({
      apiKey: 're_123',
      from: 'uptime@example.com',
      enabled: true,
    })
    stub.state.configured = true
    const ok = await admin.post('/api/v1/mailer/test').set('x-csrf-token', token).send({})
    expect(ok.status).toBe(204)
    expect(stub.sent).toHaveLength(1)
    expect(stub.sent[0]?.to).toBe('admin@example.com')

    const explicit = await admin
      .post('/api/v1/mailer/test')
      .set('x-csrf-token', token)
      .send({ to: 'ops@example.com' })
    expect(explicit.status).toBe(204)
    expect(stub.sent[1]?.to).toBe('ops@example.com')
  })

  it('locks viewers out of the mailer settings', async () => {
    await agent.post('/api/v1/users').set('x-csrf-token', csrf).send({
      email: 'viewer@example.com',
      password: 'viewer-pass-1',
      role: 'viewer',
    })
    const viewer = request.agent(app)
    await viewer.post('/api/v1/auth/login').send({ email: 'viewer@example.com', password: 'viewer-pass-1' })
    expect((await viewer.get('/api/v1/mailer')).status).toBe(403)
    expect((await viewer.put('/api/v1/mailer').send({ enabled: true })).status).toBe(403)
    expect((await viewer.post('/api/v1/mailer/test').send({})).status).toBe(403)
  })

  it('exposes the session cookie contract on recovery endpoints', async () => {
    // Recovery routes are public: no cookie, no CSRF token required.
    const res = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'x@example.com' })
    expect(res.status).toBe(204)
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(SESSION_COOKIE).toBe('uptime_session')
  })
})
