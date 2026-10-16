import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('copyText', () => {
  it('returns true and writes via the async clipboard API', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    await expect(copyText('https://example.com')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('https://example.com')
  })

  it('returns false when the clipboard API rejects (insecure context)', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) },
    })
    await expect(copyText('x')).resolves.toBe(false)
  })

  it('returns false when no clipboard API exists', async () => {
    vi.stubGlobal('navigator', {})
    await expect(copyText('x')).resolves.toBe(false)
  })
})
