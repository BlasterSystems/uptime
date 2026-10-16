import { describe, expect, it } from 'vitest'
import { pushMonitorConfigSchema } from './config-push.js'

describe('pushMonitorConfigSchema', () => {
  it('defaults graceSeconds to 60 and strips unknown keys', () => {
    expect(pushMonitorConfigSchema.parse({})).toEqual({ graceSeconds: 60 })
    expect(pushMonitorConfigSchema.parse({ graceSeconds: 120, expectsBody: true, rogue: 1 })).toEqual(
      { graceSeconds: 120, expectsBody: true },
    )
  })

  it('rejects non-positive grace seconds and non-boolean expectsBody', () => {
    expect(pushMonitorConfigSchema.safeParse({ graceSeconds: 0 }).success).toBe(false)
    expect(pushMonitorConfigSchema.safeParse({ expectsBody: 'yes' }).success).toBe(false)
  })

  it('accepts only 5 or 6 cron fields drawn from [0-9*/,-]', () => {
    expect(pushMonitorConfigSchema.safeParse({ cron: '0 3 * * *' }).success).toBe(true)
    expect(pushMonitorConfigSchema.safeParse({ cron: '*/5 * * * * *' }).success).toBe(true)
    expect(pushMonitorConfigSchema.safeParse({ cron: '0 3 * *' }).success).toBe(false)
    expect(pushMonitorConfigSchema.safeParse({ cron: '0 3 * * FOO' }).success).toBe(false)
  })
})
