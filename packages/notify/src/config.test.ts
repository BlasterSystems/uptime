import { describe, expect, it } from 'vitest'
import { parseChannelConfig } from './config.js'
import type { ChannelType } from './types.js'

describe('parseChannelConfig', () => {
  it('applies the documented defaults', () => {
    expect(parseChannelConfig('resend', { apiKey: 're_123', from: 'a@b.c', to: 'd@e.f' })).toEqual({
      apiKey: 're_123',
      from: 'a@b.c',
      to: 'd@e.f',
      apiBaseUrl: 'https://api.resend.com',
    })
  })

  it('keeps explicit values, including test overrides', () => {
    expect(
      parseChannelConfig('resend', {
        apiKey: 're_123',
        from: 'a@b.c',
        to: 'd@e.f',
        apiBaseUrl: 'http://127.0.0.1:8080',
      }),
    ).toEqual({ apiKey: 're_123', from: 'a@b.c', to: 'd@e.f', apiBaseUrl: 'http://127.0.0.1:8080' })
  })

  it('strips unknown keys', () => {
    const parsed = parseChannelConfig('resend', {
      apiKey: 're_123',
      from: 'a@b.c',
      to: 'd@e.f',
      injected: 'nope',
    })
    expect(parsed).toEqual({
      apiKey: 're_123',
      from: 'a@b.c',
      to: 'd@e.f',
      apiBaseUrl: 'https://api.resend.com',
    })
    expect('injected' in parsed).toBe(false)
  })

  it('rejects invalid configs', () => {
    const invalids: Array<[label: string, type: ChannelType, raw: unknown]> = [
      ['resend without apiKey', 'resend', { from: 'a@b.c', to: 'd@e.f' }],
      ['resend without from', 'resend', { apiKey: 're_123', to: 'd@e.f' }],
      ['resend without to', 'resend', { apiKey: 're_123', from: 'a@b.c' }],
      [
        'resend with a bad apiBaseUrl',
        'resend',
        { apiKey: 're_123', from: 'a@b.c', to: 'd@e.f', apiBaseUrl: 'notaurl' },
      ],
    ]
    for (const [label, type, raw] of invalids) {
      expect(() => parseChannelConfig(type, raw), label).toThrow()
    }
  })

  it('rejects types removed by ADR-0007 as unsupported', () => {
    for (const removed of ['telegram', 'discord', 'slack', 'email', 'ntfy', 'gotify', 'webhook']) {
      expect(() => parseChannelConfig(removed as ChannelType, {}), removed).toThrow(
        `unsupported channel type: ${removed}`,
      )
    }
  })
})
