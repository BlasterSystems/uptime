vi.hoisted(() => {
  // theme.ts reads the OS preference at module init; jsdom has no matchMedia.
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() }))
})

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { THEME_STORAGE_KEY, initTheme, theme, toggleTheme } from './theme.js'

function matchMediaMock(): Mock {
  return vi.mocked(matchMedia) as unknown as Mock
}

beforeEach(() => {
  window.localStorage.clear()
  delete document.documentElement.dataset.theme
  theme.value = 'light'
})

describe('theme', () => {
  it('applies a stored preference and keeps it persisted', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    initTheme()
    expect(theme.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('ignores invalid stored values and follows the OS preference instead', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    matchMediaMock().mockReturnValue({ matches: true, addEventListener: vi.fn() })
    initTheme()
    expect(theme.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it('toggles and persists the explicit choice', () => {
    theme.value = 'light'
    toggleTheme()
    expect(theme.value).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    toggleTheme()
    expect(theme.value).toBe('light')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  it('initializes to the OS theme when nothing is stored', () => {
    matchMediaMock().mockReturnValue({ matches: false, addEventListener: vi.fn() })
    initTheme()
    expect(theme.value).toBe('light')
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })
})
