import { Router } from 'express'
import type { Request, RequestHandler, Response } from 'express'
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2'
import type { Algorithm } from '@node-rs/argon2'
import type { ApiKeyRow, Database, SecretBox, UserRole, UserRow } from '@uptime/db'
import { SlidingWindowRateLimiter } from './rate-limit.js'
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp.js'
import type { MailerLike } from '../mailer.js'

/** Session cookie (httpOnly, SameSite=Lax, Path=/; Secure when the request is). */
export const SESSION_COOKIE = 'uptime_session'

export interface AuthModule {
  router: Router
  requireAuth: (minRole: 'admin' | 'editor' | 'viewer') => RequestHandler
}

/** Per-request identity attached to `res.locals.auth` by `requireAuth`. */
interface AuthContext {
  userId: number | null
  email: string | null
  role: UserRole | null
  via: 'session' | 'api-key'
  csrfToken?: string
  scopes?: ApiKeyScope[]
}

const SESSION_TTL_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000
const LOGIN_FAILURE_LIMIT = 5
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000
const MIN_PASSWORD_LENGTH = 8
const RECOVERY_CODE_COUNT = 10
const RECOVERY_CODE_LENGTH = 10
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000
/** Password-reset attempts per window; every request counts (enumeration-safe). */
const FORGOT_ATTEMPT_LIMIT = 5
const FORGOT_WINDOW_MS = 60 * 60 * 1000
const RESET_ATTEMPT_LIMIT = 10
const RESET_WINDOW_MS = 60 * 60 * 1000

const API_KEY_SCOPES = ['read', 'write', 'admin'] as const
type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

/** OWASP baseline: Argon2id, m=19456 KiB, t=2, p=1. */
const ARGON2_OPTIONS = {
  algorithm: 2 as Algorithm,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
}

const ROLE_RANK: Record<UserRole, number> = { viewer: 1, editor: 2, admin: 3 }
const SCOPE_RANK: Record<ApiKeyScope, number> = { read: 1, write: 2, admin: 3 }
const MIN_SCOPE: Record<UserRole, ApiKeyScope> = { viewer: 'read', editor: 'write', admin: 'admin' }

function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === 'string' && (API_KEY_SCOPES as readonly string[]).includes(value)
}

/** Trims an optional body string field; empty/absent → undefined. */
function stringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function bodyOf(req: Request): Record<string, unknown> {
  const body: unknown = req.body
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
}

function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null
  for (const part of header.split(';')) {
    const equals = part.indexOf('=')
    if (equals === -1) continue
    if (part.slice(0, equals).trim() !== name) continue
    const raw = part.slice(equals + 1).trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return null
}

function readBearerToken(req: Request): string | null {
  const header = req.get('authorization')
  const match = header === undefined ? null : /^Bearer +(.+)$/i.exec(header.trim())
  const token = match?.[1]?.trim()
  return token === undefined || token.length === 0 ? null : token
}

/** Accepts an ISO string or unix-ms number; `null` = absent, `'invalid'` = reject. */
function parseExpiresAt(value: unknown): Date | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null
  const date =
    typeof value === 'number' ? new Date(value) : typeof value === 'string' ? new Date(value) : null
  return date !== null && !Number.isNaN(date.getTime()) ? date : 'invalid'
}

export function createAuthModule(deps: {
  db: Database
  secrets: SecretBox
  sessionTtlMs?: number
  /** Outbound email for password recovery; recovery is inert when absent. */
  mailer?: MailerLike
}): AuthModule {
  const { db, secrets } = deps
  const sessionTtlMs = deps.sessionTtlMs ?? SESSION_TTL_DEFAULT_MS
  const loginLimiter = new SlidingWindowRateLimiter({
    limit: LOGIN_FAILURE_LIMIT,
    windowMs: LOGIN_FAILURE_WINDOW_MS,
  })
  const forgotLimiter = new SlidingWindowRateLimiter({
    limit: FORGOT_ATTEMPT_LIMIT,
    windowMs: FORGOT_WINDOW_MS,
  })
  const resetLimiter = new SlidingWindowRateLimiter({
    limit: RESET_ATTEMPT_LIMIT,
    windowMs: RESET_WINDOW_MS,
  })
  const router = Router()

  async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await argon2Verify(passwordHash, password)
    } catch {
      return false // malformed/foreign hash — never authenticate
    }
  }

  function verifySecondFactor(user: UserRow, otp: string): boolean {
    if (user.totpSecretEnc === null) return false
    try {
      return verifyTotp(secrets.decrypt(user.totpSecretEnc), otp)
    } catch {
      return false
    }
  }

  function consumeRecoveryCode(user: UserRow, code: string): boolean {
    if (user.recoveryCodesEnc === null) return false
    let hashes: string[]
    try {
      hashes = secrets.decryptJson<string[]>(user.recoveryCodesEnc)
    } catch {
      return false
    }
    const index = hashes.indexOf(secrets.hash(code))
    if (index === -1) return false
    hashes.splice(index, 1)
    db.updateUser(user.id, { recoveryCodesEnc: secrets.encryptJson(hashes) })
    return true
  }

  /** Prunes stale sessions, creates one and sets the cookie. */
  function issueSession(req: Request, res: Response, user: UserRow): string {
    db.deleteExpiredSessions(new Date())
    const csrfToken = secrets.token(32)
    const session = db.createSession({
      id: secrets.token(32),
      userId: user.id,
      csrfToken,
      expiresAt: new Date(Date.now() + sessionTtlMs),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    })
    res.cookie(SESSION_COOKIE, session.id, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: req.secure,
      maxAge: sessionTtlMs,
    })
    return csrfToken
  }

  /** Setup and login share this response shape (auto-login). */
  function completeLogin(req: Request, res: Response, user: UserRow): void {
    const csrfToken = issueSession(req, res, user)
    res.json({ user: { id: user.id, email: user.email, role: user.role }, csrfToken })
  }

  /** Resolves `res.locals.auth` back to a live user (2FA routes act on it). */
  function currentUser(res: Response): UserRow | null {
    const auth = res.locals.auth as AuthContext | undefined
    return auth === undefined || auth.userId === null ? null : db.getUser(auth.userId)
  }

  const requireAuth = (minRole: 'admin' | 'editor' | 'viewer'): RequestHandler => {
    return (req, res, next) => {
      const token = readBearerToken(req)
      if (token !== null) {
        const apiKey = db.getApiKeyByKeyHash(secrets.hash(token))
        if (
          apiKey === null ||
          (apiKey.expiresAt !== null && apiKey.expiresAt.getTime() <= Date.now())
        ) {
          res.status(401).json({ error: 'invalid_api_key' })
          return
        }
        const scopes = apiKey.scopes.filter(isApiKeyScope)
        if (!scopes.some((scope) => SCOPE_RANK[scope] >= SCOPE_RANK[MIN_SCOPE[minRole]])) {
          res.status(403).json({ error: 'insufficient_scope' })
          return
        }
        db.touchApiKey(apiKey.id, new Date())
        const owner = apiKey.createdBy === null ? null : db.getUser(apiKey.createdBy)
        const context: AuthContext = {
          userId: apiKey.createdBy,
          email: owner?.email ?? null,
          role: owner?.role ?? null,
          via: 'api-key',
          scopes,
        }
        res.locals.auth = context
        next()
        return
      }

      const sessionId = readCookie(req.headers.cookie, SESSION_COOKIE)
      const session = sessionId === null ? null : db.getSession(sessionId)
      if (session === null) {
        res.status(401).json({ error: 'unauthenticated' })
        return
      }
      const mutating =
        req.method === 'POST' ||
        req.method === 'PUT' ||
        req.method === 'PATCH' ||
        req.method === 'DELETE'
      if (mutating && req.get('x-csrf-token') !== session.csrfToken) {
        res.status(403).json({ error: 'csrf' })
        return
      }
      const user = db.getUser(session.userId)
      if (user === null) {
        db.deleteSession(session.id)
        res.status(401).json({ error: 'unauthenticated' })
        return
      }
      if (ROLE_RANK[user.role] < ROLE_RANK[minRole]) {
        res.status(403).json({ error: 'insufficient_role' })
        return
      }
      const context: AuthContext = {
        userId: user.id,
        email: user.email,
        role: user.role,
        via: 'session',
        csrfToken: session.csrfToken,
      }
      res.locals.auth = context
      next()
    }
  }

  router.get('/state', (_req, res) => {
    res.json({ setupRequired: db.countUsers() === 0 })
  })

  router.post('/setup', async (req, res) => {
    if (db.countUsers() > 0) {
      res.status(409).json({ error: 'setup_complete' })
      return
    }
    const body = bodyOf(req)
    const email = stringField(body, 'email')
    // Passwords are hashed verbatim — never trimmed.
    const password: unknown = body.password
    if (email === undefined || !EMAIL_PATTERN.test(email)) {
      res.status(400).json({ error: 'invalid_email' })
      return
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: 'invalid_password' })
      return
    }
    const passwordHash = await argon2Hash(password, ARGON2_OPTIONS)
    // Re-check after the await: the count→insert pair below is synchronous.
    if (db.countUsers() > 0) {
      res.status(409).json({ error: 'setup_complete' })
      return
    }
    const user = db.createUser({ email, passwordHash, role: 'admin' })
    completeLogin(req, res, user)
  })

  router.post('/login', async (req, res) => {
    const limiterKey = req.ip ?? req.socket.remoteAddress ?? 'unknown'
    const decision = loginLimiter.check(limiterKey)
    if (decision.limited) {
      res.status(429).json({ error: 'too_many_attempts', retryAfterMs: decision.retryAfterMs })
      return
    }
    const body = bodyOf(req)
    const email = stringField(body, 'email')
    const password: unknown = body.password
    const otp = stringField(body, 'otp')
    const recoveryCode = stringField(body, 'recoveryCode')

    const user = email === undefined ? null : db.getUserByEmail(email)
    if (
      user === null ||
      typeof password !== 'string' ||
      !(await verifyPassword(user.passwordHash, password))
    ) {
      loginLimiter.recordFailure(limiterKey)
      res.status(401).json({ error: 'invalid_credentials' })
      return
    }

    if (user.totpEnabled) {
      if (otp === undefined && recoveryCode === undefined) {
        res.status(401).json({ error: '2fa_required' })
        return
      }
      const secondFactorOk =
        otp !== undefined
          ? verifySecondFactor(user, otp)
          : consumeRecoveryCode(user, recoveryCode ?? '')
      if (!secondFactorOk) {
        loginLimiter.recordFailure(limiterKey)
        res.status(401).json({ error: otp !== undefined ? 'invalid_otp' : 'invalid_recovery_code' })
        return
      }
    }

    loginLimiter.reset(limiterKey)
    completeLogin(req, res, user)
  })

  // Password recovery (SPEC §5). Always 204 and always rate-counted so the
  // endpoint neither confirms nor denies whether an email exists or mail is
  // configured. The reset link uses the request origin; `sendMail` failures are
  // logged, not surfaced, for the same reason.
  router.post('/forgot-password', async (req, res) => {
    const limiterKey = req.ip ?? req.socket.remoteAddress ?? 'unknown'
    const decision = forgotLimiter.check(limiterKey)
    if (decision.limited) {
      res.status(429).json({ error: 'too_many_attempts', retryAfterMs: decision.retryAfterMs })
      return
    }
    forgotLimiter.recordFailure(limiterKey)

    const email = stringField(bodyOf(req), 'email')
    const user = email === undefined || !EMAIL_PATTERN.test(email) ? null : db.getUserByEmail(email)
    const mailer = deps.mailer
    if (user !== null && mailer !== undefined && mailer.configured) {
      const rawToken = secrets.token(32)
      db.createPasswordResetToken({
        userId: user.id,
        rawToken,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      })
      const origin = `${req.protocol}://${req.get('host') ?? 'localhost'}`
      const link = `${origin}/reset-password?token=${encodeURIComponent(rawToken)}`
      try {
        await mailer.sendMail({
          to: user.email,
          subject: 'Reset your password',
          text: `Use this link within one hour to choose a new password:\n\n${link}\n\nIf you did not request a reset, ignore this email.`,
          html: `<p>Use this link within one hour to choose a new password:</p><p><a href="${link}">${link}</a></p><p>If you did not request a reset, ignore this email.</p>`,
        })
      } catch (error) {
        console.warn(
          `password reset email for ${user.email} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        )
      }
    }
    res.status(204).send()
  })

  router.post('/reset-password', async (req, res) => {
    const limiterKey = req.ip ?? req.socket.remoteAddress ?? 'unknown'
    const decision = resetLimiter.check(limiterKey)
    if (decision.limited) {
      res.status(429).json({ error: 'too_many_attempts', retryAfterMs: decision.retryAfterMs })
      return
    }
    resetLimiter.recordFailure(limiterKey)

    const body = bodyOf(req)
    const rawToken = stringField(body, 'token')
    const password: unknown = body.password
    if (rawToken === undefined) {
      res.status(400).json({ error: 'invalid_token' })
      return
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: 'invalid_password' })
      return
    }
    const row = db.getValidPasswordResetToken(rawToken)
    if (row === null) {
      res.status(400).json({ error: 'invalid_token' })
      return
    }
    const user = db.getUser(row.userId)
    if (user === null) {
      res.status(400).json({ error: 'invalid_token' })
      return
    }
    db.updateUser(user.id, { passwordHash: await argon2Hash(password, ARGON2_OPTIONS) })
    db.markPasswordResetTokenUsed(row.id, new Date())
    // The caller proves ownership of the token, not a session: revoke all of them.
    db.deleteUserSessions(user.id)
    resetLimiter.reset(limiterKey)
    res.status(204).send()
  })

  router.post('/logout', (req, res) => {
    const sessionId = readCookie(req.headers.cookie, SESSION_COOKIE)
    if (sessionId !== null) db.deleteSession(sessionId)
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: req.secure,
    })
    res.status(204).send()
  })

  router.get('/me', requireAuth('viewer'), (_req, res) => {
    const auth = res.locals.auth as AuthContext
    res.json({
      user: { id: auth.userId, email: auth.email, role: auth.role },
      csrfToken: auth.csrfToken ?? null,
    })
  })

  router.post('/2fa/setup', requireAuth('viewer'), (_req, res) => {
    const user = currentUser(res)
    if (user === null) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }
    if (user.totpEnabled) {
      res.status(409).json({ error: 'totp_already_enabled' })
      return
    }
    const secret = generateTotpSecret()
    db.updateUser(user.id, { totpSecretEnc: secrets.encrypt(secret) })
    res.json({ secret, otpauthUrl: otpauthUrl(user.email, secret) })
  })

  router.post('/2fa/verify', requireAuth('viewer'), (req, res) => {
    const user = currentUser(res)
    if (user === null) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }
    if (user.totpSecretEnc === null) {
      res.status(400).json({ error: 'totp_not_setup' })
      return
    }
    const otp = stringField(bodyOf(req), 'otp')
    if (otp === undefined || !verifySecondFactor(user, otp)) {
      res.status(400).json({ error: 'invalid_otp' })
      return
    }
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      secrets.token(8).slice(0, RECOVERY_CODE_LENGTH),
    )
    db.updateUser(user.id, {
      totpEnabled: true,
      recoveryCodesEnc: secrets.encryptJson(recoveryCodes.map((code) => secrets.hash(code))),
    })
    res.json({ recoveryCodes })
  })

  router.post('/2fa/disable', requireAuth('viewer'), async (req, res) => {
    const user = currentUser(res)
    if (user === null) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }
    const password = stringField(bodyOf(req), 'password')
    if (password === undefined || !(await verifyPassword(user.passwordHash, password))) {
      res.status(401).json({ error: 'invalid_password' })
      return
    }
    db.updateUser(user.id, { totpEnabled: false, totpSecretEnc: null, recoveryCodesEnc: null })
    res.json({ ok: true })
  })

  router.post('/change-password', requireAuth('viewer'), async (req, res) => {
    const auth = res.locals.auth as AuthContext
    if (auth.via !== 'session') {
      // API keys cannot present the current password, so they must not rotate it.
      res.status(403).json({ error: 'session_required' })
      return
    }
    const user = currentUser(res)
    if (user === null) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }
    const body = bodyOf(req)
    const currentPassword = stringField(body, 'currentPassword')
    const nextPassword = stringField(body, 'nextPassword')
    if (
      currentPassword === undefined ||
      !(await verifyPassword(user.passwordHash, currentPassword))
    ) {
      res.status(401).json({ error: 'invalid_credentials' })
      return
    }
    if (nextPassword === undefined || nextPassword.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: 'invalid_password' })
      return
    }
    db.updateUser(user.id, { passwordHash: await argon2Hash(nextPassword, ARGON2_OPTIONS) })
    // Every other device signs out; the caller keeps this session.
    db.deleteUserSessions(user.id, readCookie(req.headers.cookie, SESSION_COOKIE) ?? undefined)
    res.status(204).send()
  })

  router.post('/api-keys', requireAuth('admin'), (req, res) => {
    const auth = res.locals.auth as AuthContext
    const body = bodyOf(req)
    const name = stringField(body, 'name')
    if (name === undefined) {
      res.status(400).json({ error: 'invalid_name' })
      return
    }
    const rawScopes: unknown = body.scopes
    if (!Array.isArray(rawScopes) || rawScopes.length === 0) {
      res.status(400).json({ error: 'invalid_scopes' })
      return
    }
    const scopes: ApiKeyScope[] = []
    for (const scope of rawScopes) {
      if (!isApiKeyScope(scope)) {
        res.status(400).json({ error: 'invalid_scopes' })
        return
      }
      if (!scopes.includes(scope)) scopes.push(scope)
    }
    const expiresAt = parseExpiresAt(body.expiresAt)
    if (expiresAt === 'invalid') {
      res.status(400).json({ error: 'invalid_expires_at' })
      return
    }
    const key = `uk_${secrets.token(24)}`
    db.createApiKey({
      name,
      keyHash: secrets.hash(key),
      scopes,
      createdBy: auth.userId ?? undefined,
      expiresAt: expiresAt ?? undefined,
    })
    res.status(201).json({ key })
  })

  router.get('/api-keys', requireAuth('admin'), (_req, res) => {
    const keys = db.listApiKeys().map((key: ApiKeyRow) => ({
      id: key.id,
      name: key.name,
      scopes: key.scopes,
      createdBy: key.createdBy,
      lastUsedAt: key.lastUsedAt,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
    }))
    res.json({ apiKeys: keys })
  })

  router.delete('/api-keys/:id', requireAuth('admin'), (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid_id' })
      return
    }
    if (!db.deleteApiKey(id)) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    res.status(204).send()
  })

  return { router, requireAuth }
}

/** Roles accepted by the users API; mirrors `UserRole` without importing the schema. */
const USER_ROLES: UserRole[] = ['admin', 'editor', 'viewer']

function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as string[]).includes(value)
}

function countAdmins(db: Database): number {
  return db.listUsers().filter((user) => user.role === 'admin').length
}

/**
 * Admin user management (`/api/v1/users`): list, create, edit (role, password
 * reset) and delete. Self-delete and last-admin guards are enforced here so
 * an instance can never lock itself out. Hashing stays in this module.
 */
export function createUsersRouter(deps: { db: Database; auth: AuthModule }): Router {
  const { db } = deps
  const { requireAuth } = deps.auth
  const router = Router()

  const publicUser = (row: UserRow) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    totpEnabled: row.totpEnabled,
    createdAt: row.createdAt.toISOString(),
  })

  router.get('/', requireAuth('admin'), (_req, res) => {
    res.json({ users: db.listUsers().map(publicUser) })
  })

  router.post('/', requireAuth('admin'), async (req, res) => {
    const body = bodyOf(req)
    const email = stringField(body, 'email')
    const password = stringField(body, 'password')
    const role = stringField(body, 'role') ?? 'viewer'
    if (email === undefined || !EMAIL_PATTERN.test(email)) {
      res.status(400).json({ error: 'invalid_email' })
      return
    }
    if (password === undefined || password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: 'invalid_password' })
      return
    }
    if (!isUserRole(role)) {
      res.status(400).json({ error: 'invalid_role' })
      return
    }
    if (db.getUserByEmail(email) !== null) {
      res.status(409).json({ error: 'email_taken' })
      return
    }
    const user = db.createUser({ email, passwordHash: await argon2Hash(password, ARGON2_OPTIONS), role })
    res.status(201).json({ user: publicUser(user) })
  })

  router.patch('/:id', requireAuth('admin'), async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid_id' })
      return
    }
    const target = db.getUser(id)
    if (target === null) {
      res.status(404).json({ error: 'user_not_found' })
      return
    }
    const body = bodyOf(req)
    const patch: { passwordHash?: string; role?: UserRole } = {}
    if (body.role !== undefined) {
      if (typeof body.role !== 'string' || !isUserRole(body.role)) {
        res.status(400).json({ error: 'invalid_role' })
        return
      }
      if (
        target.role === 'admin' &&
        body.role !== 'admin' &&
        countAdmins(db) === 1
      ) {
        res.status(409).json({ error: 'last_admin' })
        return
      }
      patch.role = body.role
    }
    if (body.password !== undefined) {
      if (typeof body.password !== 'string' || body.password.length < MIN_PASSWORD_LENGTH) {
        res.status(400).json({ error: 'invalid_password' })
        return
      }
      patch.passwordHash = await argon2Hash(body.password, ARGON2_OPTIONS)
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'empty_patch' })
      return
    }
    const updated = db.updateUser(id, patch)
    if (updated === null) {
      res.status(404).json({ error: 'user_not_found' })
      return
    }
    if (patch.passwordHash !== undefined) db.deleteUserSessions(id)
    res.json({ user: publicUser(updated) })
  })

  router.delete('/:id', requireAuth('admin'), (req, res) => {
    const auth = res.locals.auth as AuthContext
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid_id' })
      return
    }
    if (auth.userId === id) {
      res.status(400).json({ error: 'cannot_delete_self' })
      return
    }
    const target = db.getUser(id)
    if (target === null) {
      res.status(404).json({ error: 'user_not_found' })
      return
    }
    if (target.role === 'admin' && countAdmins(db) === 1) {
      res.status(409).json({ error: 'last_admin' })
      return
    }
    if (!db.deleteUser(id)) {
      res.status(404).json({ error: 'user_not_found' })
      return
    }
    db.deleteUserSessions(id)
    res.status(204).send()
  })

  return router
}
