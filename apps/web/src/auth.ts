/**
 * Session state: bootstrapped once per page load, then kept in sync with the
 * login / setup / logout endpoints. The CSRF token lives in the API module so
 * every mutation sends it without the views knowing.
 */
import { computed, reactive, type ComputedRef } from 'vue'
import {
  fetchAuthState,
  fetchMe,
  login as loginRequest,
  logout as logoutRequest,
  setCsrfToken,
  setupAdmin as setupRequest,
  type AuthSession,
  type User,
} from './api.js'

export interface AuthState {
  user: User | null
  csrfToken: string | null
  setupRequired: boolean
  /** True once the boot probe finished; router guards wait for it. */
  ready: boolean
}

const state = reactive<AuthState>({
  user: null,
  csrfToken: null,
  setupRequired: false,
  ready: false,
})

export const authState: Readonly<AuthState> = state
export const isAuthenticated = computed(() => state.user !== null)
export const isAdmin = computed(() => state.user?.role === 'admin')

export function applySession(session: AuthSession): void {
  state.user = session.user
  state.csrfToken = session.csrfToken
  setCsrfToken(session.csrfToken)
}

export function clearSession(): void {
  state.user = null
  state.csrfToken = null
  setCsrfToken(null)
}

/** Re-validates the session against `GET /auth/me`; returns whether it is live. */
export async function refreshSession(): Promise<boolean> {
  const session = await fetchMe()
  if (session === null) {
    clearSession()
    return false
  }
  applySession(session)
  return true
}

/** Surface returned by {@link useAuth}, typed concretely for consumers. */
export interface AuthApi {
  state: Readonly<AuthState>
  isAuthenticated: ComputedRef<boolean>
  isAdmin: ComputedRef<boolean>
  signIn: (email: string, password: string, otp?: string) => Promise<void>
  signOut: () => Promise<void>
  completeSetup: (email: string, password: string) => Promise<void>
  refreshSession: () => Promise<boolean>
  clearSession: () => void
}

/** One-shot boot probe run by the router guard before the first navigation. */
export async function bootstrapAuth(): Promise<void> {
  try {
    const { setupRequired } = await fetchAuthState()
    state.setupRequired = setupRequired
    if (!setupRequired) await refreshSession()
  } catch {
    // An unreachable API surfaces through the view that needs data; boot must not hang.
    clearSession()
  }
  state.ready = true
}

export async function signIn(email: string, password: string, otp?: string): Promise<void> {
  applySession(
    await loginRequest(otp === undefined ? { email, password } : { email, password, otp }),
  )
}

export async function completeSetup(email: string, password: string): Promise<void> {
  const session = await setupRequest({ email, password })
  applySession(session)
  state.setupRequired = false
}

export async function signOut(): Promise<void> {
  try {
    await logoutRequest()
  } finally {
    clearSession()
  }
}

export function useAuth(): AuthApi {
  return {
    state: authState,
    isAuthenticated,
    isAdmin,
    signIn,
    signOut,
    completeSetup,
    refreshSession,
    clearSession,
  }
}
