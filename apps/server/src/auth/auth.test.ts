import { describe, expect, it } from 'vitest'
import express from 'express'
import type { Express } from 'express'
import request from 'supertest'
import type { Agent } from 'supertest'
import { hash as argon2Hash } from '@node-rs/argon2'
import { Database, SecretBox } from '@uptime/db'
import { SESSION_COOKIE, createAuthModule } from './index.js'
import { totpCode } from './totp.js'

const ADMIN_EMAIL = 'admin@example.com'
const PASSWORD = 'correct horse battery staple'

function makeApp(options: { sessionTtlMs?: number } = {}) {
  const db = Database.open({ file: ':memory:' })
  const secrets = new SecretBox('a'.repeat(64))
  const auth = createAuthModule({ db, secrets, ...options })
  const app = express()
  app.use(express.json())
  app.use('/api/v1/auth', auth.router)
  return { app, db, secrets }
}

async function setupAdmin(app: Express): Promise<void> {
  await request(app)
    .post('/api/v1/auth/setup')
    .send({ email: ADMIN_EMAIL, password: PASSWORD })
    .expect(200)
}

async function signIn(app: Express, email = ADMIN_EMAIL, extra: Record<string, string> = {}) {
  const agent = request.agent(app)
  const response = await agent
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD, ...extra })
    .expect(200)
  return { agent, csrfToken: response.body.csrfToken as string, user: response.body.user }
}

async function enableTotp(agent: Agent, csrfToken: string) {
  const setup = await agent
    .post('/api/v1/auth/2fa/setup')
    .set('x-csrf-token', csrfToken)
    .expect(200)
  const secret = setup.body.secret as string
  const verified = await agent
    .post('/api/v1/auth/2fa/verify')
    .set('x-csrf-token', csrfToken)
    .send({ otp: totpCode(secret) })
    .expect(200)
  return { secret, recoveryCodes: verified.body.recoveryCodes as string[] }
}

describe('auth', () => {
  it('setup → login → me → logout roundtrip', async () => {
    const { app } = makeApp()

    await request(app).get('/api/v1/auth/state').expect(200, { setupRequired: true })

    const setup = await request(app)
      .post('/api/v1/auth/setup')
      .send({ email: ADMIN_EMAIL, password: PASSWORD })
      .expect(200)
    expect(setup.body.user).toEqual({ id: expect.any(Number), email: ADMIN_EMAIL, role: 'admin' })
    expect(typeof setup.body.csrfToken).toBe('string')
    const cookie = (setup.headers['set-cookie'] as unknown as string[]).join('; ')
    expect(cookie).toContain(`${SESSION_COOKIE}=`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')

    await request(app).get('/api/v1/auth/state').expect(200, { setupRequired: false })
    await request(app)
      .post('/api/v1/auth/setup')
      .send({ email: 'late@example.com', password: PASSWORD })
      .expect(409)

    const { agent, csrfToken } = await signIn(app)
    const me = await agent.get('/api/v1/auth/me').expect(200)
    expect(me.body.user).toEqual({ id: setup.body.user.id, email: ADMIN_EMAIL, role: 'admin' })
    expect(me.body.csrfToken).toBe(csrfToken)

    await agent.post('/api/v1/auth/logout').expect(204)
    await agent.get('/api/v1/auth/me').expect(401)
  })

  it('rejects wrong passwords and locks out after 5 failures', async () => {
    const { app } = makeApp()
    await setupAdmin(app)

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failure = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: ADMIN_EMAIL, password: 'wrong-password' })
        .expect(401)
      expect(failure.body.error).toBe('invalid_credentials')
    }
    const locked = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: PASSWORD })
      .expect(429)
    expect(locked.body.error).toBe('too_many_attempts')
    expect(locked.body.retryAfterMs).toBeGreaterThan(0)
  })

  it('answers unknown emails exactly like wrong passwords', async () => {
    const { app } = makeApp()
    await setupAdmin(app)

    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: PASSWORD })
      .expect(401)
    expect(unknown.body.error).toBe('invalid_credentials')
  })

  it('requires x-csrf-token on session-authenticated mutations', async () => {
    const { app } = makeApp()
    await setupAdmin(app)
    const { agent, csrfToken } = await signIn(app)

    const missing = await agent.post('/api/v1/auth/2fa/setup').expect(403)
    expect(missing.body.error).toBe('csrf')

    const wrong = await agent
      .post('/api/v1/auth/2fa/setup')
      .set('x-csrf-token', 'not-the-token')
      .expect(403)
    expect(wrong.body.error).toBe('csrf')

    const allowed = await agent
      .post('/api/v1/auth/2fa/setup')
      .set('x-csrf-token', csrfToken)
      .expect(200)
    expect(allowed.body.secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(allowed.body.otpauthUrl).toContain('otpauth://totp/')
    expect(allowed.body.otpauthUrl).toContain(`secret=${allowed.body.secret}`)

    // Reads need no CSRF header at all.
    await agent.get('/api/v1/auth/me').expect(200)
  })

  it('authenticates Bearer API keys, touches lastUsedAt and skips CSRF', async () => {
    const { app, db } = makeApp()
    await setupAdmin(app)
    const { agent, csrfToken } = await signIn(app)

    const created = await agent
      .post('/api/v1/auth/api-keys')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'ci', scopes: ['read'] })
      .expect(201)
    const key = created.body.key as string
    expect(key).toMatch(/^uk_/)

    expect(db.listApiKeys().find((row) => row.name === 'ci')?.lastUsedAt).toBeNull()

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${key}`)
      .expect(200)
    expect(me.body.user).toMatchObject({ email: ADMIN_EMAIL, role: 'admin' })
    expect(me.body.csrfToken).toBeNull()
    expect(db.listApiKeys().find((row) => row.name === 'ci')?.lastUsedAt).toBeInstanceOf(Date)

    // The Bearer path is header-only: mutations need no CSRF token.
    const disabled = await request(app)
      .post('/api/v1/auth/2fa/disable')
      .set('Authorization', `Bearer ${key}`)
      .send({ password: PASSWORD })
      .expect(200)
    expect(disabled.body).toEqual({ ok: true })

    await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer uk_unknown').expect(401)
  })

  it('rejects users whose role is too low', async () => {
    const { app, db } = makeApp()
    await setupAdmin(app)
    await db.createUser({
      email: 'viewer@example.com',
      passwordHash: await argon2Hash(PASSWORD),
      role: 'viewer',
    })

    const { agent, csrfToken } = await signIn(app, 'viewer@example.com')
    await agent.get('/api/v1/auth/me').expect(200)

    const denied = await agent
      .post('/api/v1/auth/api-keys')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'nope', scopes: ['read'] })
      .expect(403)
    expect(denied.body.error).toBe('insufficient_role')
  })

  it('enrolls TOTP, requires it at login and consumes recovery codes once', async () => {
    const { app } = makeApp()
    await setupAdmin(app)
    const { agent, csrfToken } = await signIn(app)
    const { secret, recoveryCodes } = await enableTotp(agent, csrfToken)
    expect(recoveryCodes).toHaveLength(10)
    for (const code of recoveryCodes) expect(code).toHaveLength(10)

    const noOtp = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: PASSWORD })
      .expect(401)
    expect(noOtp.body.error).toBe('2fa_required')

    const current = totpCode(secret)
    const badOtp = current === '000000' ? '000001' : '000000'
    const rejected = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: PASSWORD, otp: badOtp })
      .expect(401)
    expect(rejected.body.error).toBe('invalid_otp')

    const withOtp = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: PASSWORD, otp: totpCode(secret) })
      .expect(200)
    expect(withOtp.body.user.email).toBe(ADMIN_EMAIL)

    const first = recoveryCodes[0]!
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: PASSWORD, recoveryCode: first })
      .expect(200)
    const reused = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: PASSWORD, recoveryCode: first })
      .expect(401)
    expect(reused.body.error).toBe('invalid_recovery_code')
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: PASSWORD, recoveryCode: recoveryCodes[1]! })
      .expect(200)

    // Disabling 2FA needs the account password and restores password-only login.
    const second = await signIn(app, ADMIN_EMAIL, { otp: totpCode(secret) })
    const wrongPassword = await second.agent
      .post('/api/v1/auth/2fa/disable')
      .set('x-csrf-token', second.csrfToken)
      .send({ password: 'not-the-password' })
      .expect(401)
    expect(wrongPassword.body.error).toBe('invalid_password')
    await second.agent
      .post('/api/v1/auth/2fa/disable')
      .set('x-csrf-token', second.csrfToken)
      .send({ password: PASSWORD })
      .expect(200)
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: PASSWORD })
      .expect(200)
  })

  it('manages API keys and enforces scopes', async () => {
    const { app } = makeApp()
    await setupAdmin(app)
    const { agent, csrfToken } = await signIn(app)

    const readKey = (
      await agent
        .post('/api/v1/auth/api-keys')
        .set('x-csrf-token', csrfToken)
        .send({ name: 'reader', scopes: ['read'] })
        .expect(201)
    ).body.key as string
    const adminKey = (
      await agent
        .post('/api/v1/auth/api-keys')
        .set('x-csrf-token', csrfToken)
        .send({
          name: 'root',
          scopes: ['admin'],
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(201)
    ).body.key as string

    await agent
      .post('/api/v1/auth/api-keys')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'bad', scopes: ['superuser'] })
      .expect(400)
    await agent
      .post('/api/v1/auth/api-keys')
      .set('x-csrf-token', csrfToken)
      .send({ scopes: ['read'] })
      .expect(400)

    const list = await agent.get('/api/v1/auth/api-keys').expect(200)
    expect(list.body.apiKeys).toHaveLength(2)
    for (const row of list.body.apiKeys) expect(row).not.toHaveProperty('keyHash')
    const reader = list.body.apiKeys.find((row: { name: string }) => row.name === 'reader')
    expect(reader.scopes).toEqual(['read'])
    expect(
      list.body.apiKeys.find((row: { name: string }) => row.name === 'root').expiresAt,
    ).toBeTruthy()

    // read scope reaches viewer-level routes but not admin ones.
    await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${readKey}`).expect(200)
    const denied = await request(app)
      .post('/api/v1/auth/api-keys')
      .set('Authorization', `Bearer ${readKey}`)
      .send({ name: 'nope', scopes: ['read'] })
      .expect(403)
    expect(denied.body.error).toBe('insufficient_scope')

    // admin scope manages keys without a CSRF header.
    await request(app)
      .post('/api/v1/auth/api-keys')
      .set('Authorization', `Bearer ${adminKey}`)
      .send({ name: 'from-key', scopes: ['write'] })
      .expect(201)

    await agent
      .delete(`/api/v1/auth/api-keys/${reader.id}`)
      .set('x-csrf-token', csrfToken)
      .expect(204)
    await agent
      .delete(`/api/v1/auth/api-keys/${reader.id}`)
      .set('x-csrf-token', csrfToken)
      .expect(404)
    await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${readKey}`).expect(401)
  })

  it('rejects expired sessions and expired API keys', async () => {
    const { app, db, secrets } = makeApp()
    const user = await db.createUser({
      email: ADMIN_EMAIL,
      passwordHash: await argon2Hash(PASSWORD),
      role: 'admin',
    })

    const expiredSession = db.createSession({
      id: 'expired-session',
      userId: user.id,
      csrfToken: 'csrf',
      expiresAt: new Date(Date.now() - 1000),
    })
    await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', `${SESSION_COOKIE}=${expiredSession.id}`)
      .expect(401)

    const rawKey = `uk_${secrets.token(24)}`
    db.createApiKey({
      name: 'old',
      keyHash: secrets.hash(rawKey),
      scopes: ['admin'],
      createdBy: user.id,
      expiresAt: new Date(Date.now() - 1000),
    })
    await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${rawKey}`).expect(401)
  })
})
