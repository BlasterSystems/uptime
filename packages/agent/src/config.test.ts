import { describe, expect, it } from 'vitest'
import { parseAgentConfig } from './config.js'

const MINIMAL = { serverUrl: 'http://uptime.test:3001', token: 'secret-token' }

describe('parseAgentConfig', () => {
  it('applies the documented defaults', () => {
    expect(parseAgentConfig(MINIMAL)).toEqual({
      serverUrl: 'http://uptime.test:3001',
      token: 'secret-token',
      pollIntervalS: 30,
      pulseFlushMs: 2000,
      maxQueue: 5000,
    })
  })

  it('keeps explicit values', () => {
    const config = parseAgentConfig({
      ...MINIMAL,
      pollIntervalS: 10,
      pulseFlushMs: 500,
      maxQueue: 100,
    })
    expect(config.pollIntervalS).toBe(10)
    expect(config.pulseFlushMs).toBe(500)
    expect(config.maxQueue).toBe(100)
  })

  it('rejects a missing or invalid serverUrl', () => {
    expect(() => parseAgentConfig({ token: 'secret-token' })).toThrow()
    expect(() => parseAgentConfig({ ...MINIMAL, serverUrl: 'not a url' })).toThrow()
  })

  it('rejects short tokens', () => {
    expect(() => parseAgentConfig({ ...MINIMAL, token: 'short' })).toThrow()
    expect(() => parseAgentConfig({ ...MINIMAL, token: undefined })).toThrow()
  })

  it('rejects non-positive, fractional and non-integer cadence values', () => {
    expect(() => parseAgentConfig({ ...MINIMAL, pollIntervalS: 0 })).toThrow()
    expect(() => parseAgentConfig({ ...MINIMAL, pollIntervalS: 0.5 })).toThrow()
    expect(() => parseAgentConfig({ ...MINIMAL, pulseFlushMs: -1 })).toThrow()
    expect(() => parseAgentConfig({ ...MINIMAL, pulseFlushMs: 2.5 })).toThrow()
    expect(() => parseAgentConfig({ ...MINIMAL, maxQueue: 0 })).toThrow()
    expect(() => parseAgentConfig({ ...MINIMAL, maxQueue: 2.5 })).toThrow()
  })
})
