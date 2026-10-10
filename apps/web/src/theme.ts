/**
 * Theme handling. Without a stored preference the OS setting wins and no
 * `data-theme` attribute is written, so `prefers-color-scheme` keeps applying
 * live. Toggling persists an explicit choice under `uptime-theme`.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'

export type Theme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'uptime-theme'

export const theme = ref<Theme>(readSystemTheme())
export const isDark = computed(() => theme.value === 'dark')

function readSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : null
  } catch {
    // Private modes can throw on localStorage access; fall back to the OS theme.
    return null
  }
}

function applyTheme(next: Theme, persist: boolean): void {
  theme.value = next
  if (persist) {
    document.documentElement.dataset.theme = next
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Persisting is best-effort: the toggle still works for this session.
    }
  }
}

/** Applies the stored preference (if any) and syncs the reactive theme. */
export function initTheme(): void {
  const stored = readStoredTheme()
  if (stored === null) {
    delete document.documentElement.dataset.theme
    theme.value = readSystemTheme()
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
      if (readStoredTheme() === null) theme.value = event.matches ? 'dark' : 'light'
    })
    return
  }
  applyTheme(stored, true)
}

export function toggleTheme(): void {
  applyTheme(theme.value === 'dark' ? 'light' : 'dark', true)
}

/** Surface returned by {@link useTheme}, typed concretely for consumers. */
export interface ThemeApi {
  theme: Ref<Theme>
  isDark: ComputedRef<boolean>
  toggleTheme: () => void
}

export function useTheme(): ThemeApi {
  return { theme, isDark, toggleTheme }
}
