import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useToast } from './toast.js'

beforeEach(() => {
  vi.useFakeTimers()
  const api = useToast()
  for (const toast of api.toasts.value) api.dismiss(toast.id)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('toast store', () => {
  it('pushes toasts with type, title and optional message', () => {
    const api = useToast()
    api.success('Monitor created', 'as267 prod')
    api.error('Copy failed')
    api.info('Heads up')

    const types = api.toasts.value.map((t) => t.type)
    expect(types).toEqual(['success', 'error', 'info'])
    expect(api.toasts.value[0]).toMatchObject({ title: 'Monitor created', message: 'as267 prod' })
    expect(api.toasts.value[1]?.message).toBeUndefined()
  })

  it('auto-dismisses each type after its duration', () => {
    const api = useToast()
    const successId = api.success('Created')
    const errorId = api.error('Failed')

    vi.advanceTimersByTime(5000)
    expect(api.toasts.value.some((t) => t.id === successId)).toBe(false)
    expect(api.toasts.value.some((t) => t.id === errorId)).toBe(true)

    vi.advanceTimersByTime(4000)
    expect(api.toasts.value.some((t) => t.id === errorId)).toBe(false)
  })

  it('explicit dismiss cancels the pending auto-dismiss timer', () => {
    const api = useToast()
    const id = api.info('Later')
    api.dismiss(id)
    vi.advanceTimersByTime(10_000)
    expect(api.toasts.value).toHaveLength(0)
  })

  it('returns unique ids across pushes', () => {
    const api = useToast()
    const first = api.success('a')
    const second = api.success('b')
    expect(first).not.toBe(second)
  })
})
