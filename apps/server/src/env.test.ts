import { describe, expect, it } from 'vitest'
import { readConfig } from './env.js'

describe('readConfig', () => {
  it('applies defaults', () => {
    const cfg = readConfig({})
    expect(cfg).toEqual({
      port: 3001,
      dataDir: './data',
      webDist: null,
      seed: false,
      encryptionKey: undefined,
    })
  })

  it('seeds the demo monitor only when SEED=1', () => {
    expect(readConfig({ SEED: '1' }).seed).toBe(true)
    expect(readConfig({ SEED: '0' }).seed).toBe(false)
    expect(readConfig({ SEED: 'true' }).seed).toBe(false)
  })

  it('passes TRUST_PROXY through and trims it', () => {
    expect(readConfig({}).trustProxy).toBeUndefined()
    expect(readConfig({ TRUST_PROXY: '  ' }).trustProxy).toBeUndefined()
    expect(readConfig({ TRUST_PROXY: '1' }).trustProxy).toBe('1')
    expect(readConfig({ TRUST_PROXY: ' loopback ' }).trustProxy).toBe('loopback')
  })

  it('reads env overrides', () => {
    const cfg = readConfig({
      PORT: '8080',
      DATA_DIR: '/data',
      WEB_DIST: '/web',
      SEED: '0',
      ENCRYPTION_KEY: 'k'.repeat(64),
    })
    expect(cfg).toEqual({
      port: 8080,
      dataDir: '/data',
      webDist: '/web',
      seed: false,
      encryptionKey: 'k'.repeat(64),
    })
  })

  it('falls back on invalid port', () => {
    expect(readConfig({ PORT: 'nope' }).port).toBe(3001)
    expect(readConfig({ PORT: '-1' }).port).toBe(3001)
  })
})
