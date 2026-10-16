import type * as ApiModule from './api.js'

vi.mock('./api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    fetchAuthState: vi.fn(),
    fetchMe: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(async () => undefined),
    setupAdmin: vi.fn(),
  }
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAuthState, fetchMe, login, logout, setupAdmin } from './api.js'
import type { AuthSession, User } from './api.js'
import {
  authState,
  bootstrapAuth,
  clearSession,
  completeSetup,
  isAuthenticated,
  refreshSession,
  signIn,
  signOut,
} from './auth.js'

const SESSION: AuthSession = {
  user: { id: 1, email: 'admin@example.com', role: 'admin' } as User,
  csrfToken: 'token-1',
} as AuthSession

beforeEach(() => {
  clearSession()
  authState.setupRequired = false
  authState.ready = false
  vi.mocked(fetchMe).mockReset()
  vi.mocked(fetchAuthState).mockReset()
  vi.mocked(login).mockReset()
  vi.mocked(setupAdmin).mockReset()
})

describe('session state', () => {
  it('applySession stores the user and CSRF token', () => {
    // applySession is re-exported through auth helpers' behavior; drive it via signIn.
    vi.mocked(login).mockResolvedValue(SESSION)
    return signIn('admin@example.com', 'password').then(() => {
      expect(authState.user?.email).toBe('admin@example.com')
      expect(authState.csrfToken).toBe('token-1')
      expect(isAuthenticated.value).toBe(true)
    })
  })

  it('refreshSession returns true and keeps the session when live', async () => {
    vi.mocked(fetchMe).mockResolvedValue(SESSION)
    await expect(refreshSession()).resolves.toBe(true)
    expect(authState.user).not.toBeNull()
  })

  it('refreshSession clears the session when the probe reports signed-out', async () => {
    vi.mocked(login).mockResolvedValue(SESSION)
    await signIn('admin@example.com', 'password')
    vi.mocked(fetchMe).mockResolvedValue(null)

    await expect(refreshSession()).resolves.toBe(false)
    expect(authState.user).toBeNull()
    expect(authState.csrfToken).toBeNull()
  })

  it('signOut clears the session even when the request fails', async () => {
    vi.mocked(login).mockResolvedValue(SESSION)
    await signIn('admin@example.com', 'password')
    vi.mocked(logout).mockRejectedValueOnce(new Error('network gone'))

    await expect(signOut()).rejects.toThrow('network gone')
    expect(authState.user).toBeNull()
  })

  it('completeSetup applies the session and clears setupRequired', async () => {
    authState.setupRequired = true
    vi.mocked(setupAdmin).mockResolvedValue(SESSION)
    await completeSetup('admin@example.com', 'password')
    expect(authState.setupRequired).toBe(false)
    expect(isAuthenticated.value).toBe(true)
  })
})

describe('bootstrapAuth', () => {
  it('records setupRequired and skips the session probe when setup is pending', async () => {
    vi.mocked(fetchAuthState).mockResolvedValue({ setupRequired: true })
    await bootstrapAuth()
    expect(authState.setupRequired).toBe(true)
    expect(fetchMe).not.toHaveBeenCalled()
    expect(authState.ready).toBe(true)
  })

  it('refreshes the session when setup is complete', async () => {
    vi.mocked(fetchAuthState).mockResolvedValue({ setupRequired: false })
    vi.mocked(fetchMe).mockResolvedValue(SESSION)
    await bootstrapAuth()
    expect(fetchMe).toHaveBeenCalledTimes(1)
    expect(authState.user?.email).toBe('admin@example.com')
    expect(authState.ready).toBe(true)
  })

  it('survives an unreachable API and still marks itself ready', async () => {
    vi.mocked(fetchAuthState).mockRejectedValue(new Error('down'))
    await bootstrapAuth()
    expect(authState.ready).toBe(true)
    expect(authState.user).toBeNull()
  })
})
