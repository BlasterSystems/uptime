import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { parseChannelConfig } from './config.js'
import type { ChannelType } from './types.js'

describe('parseChannelConfig', () => {
  it('applies the documented defaults', () => {
    expect(parseChannelConfig('telegram', { botToken: 'TOK', chatId: '42' })).toEqual({
      botToken: 'TOK',
      chatId: '42',
      apiBaseUrl: 'https://api.telegram.org',
    })
    expect(
      parseChannelConfig('discord', { webhookUrl: 'https://discord.com/api/webhooks/1/abc' }),
    ).toEqual({ webhookUrl: 'https://discord.com/api/webhooks/1/abc' })
    expect(
      parseChannelConfig('slack', { webhookUrl: 'https://hooks.slack.com/services/T/B/X' }),
    ).toEqual({ webhookUrl: 'https://hooks.slack.com/services/T/B/X' })
    expect(
      parseChannelConfig('email', { smtpHost: 'smtp.example.com', from: 'a@b.c', to: 'd@e.f' }),
    ).toEqual({
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      secure: false,
      from: 'a@b.c',
      to: 'd@e.f',
      transport: 'smtp',
    })
    expect(
      parseChannelConfig('resend', { apiKey: 're_123', from: 'a@b.c', to: 'd@e.f' }),
    ).toEqual({ apiKey: 're_123', from: 'a@b.c', to: 'd@e.f', apiBaseUrl: 'https://api.resend.com' })
    expect(parseChannelConfig('ntfy', { topic: 'alerts' })).toEqual({
      topic: 'alerts',
      server: 'https://ntfy.sh',
    })
    expect(
      parseChannelConfig('gotify', { server: 'https://gotify.example.com', token: 'GT' }),
    ).toEqual({ server: 'https://gotify.example.com', token: 'GT', priority: 5 })
    expect(parseChannelConfig('webhook', { url: 'https://example.com/hook' })).toEqual({
      url: 'https://example.com/hook',
      method: 'POST',
    })
  })

  it('keeps explicit overrides intact', () => {
    expect(
      parseChannelConfig('email', {
        smtpHost: 'smtp.example.com',
        smtpPort: 465,
        secure: true,
        username: 'user',
        password: 'pass',
        from: 'a@b.c',
        to: 'd@e.f',
        transport: 'json',
      }),
    ).toEqual({
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      secure: true,
      username: 'user',
      password: 'pass',
      from: 'a@b.c',
      to: 'd@e.f',
      transport: 'json',
    })
    expect(
      parseChannelConfig('telegram', {
        botToken: 'TOK',
        chatId: 42,
        apiBaseUrl: 'http://127.0.0.1:8080',
      }),
    ).toEqual({ botToken: 'TOK', chatId: 42, apiBaseUrl: 'http://127.0.0.1:8080' })
    expect(parseChannelConfig('ntfy', { topic: 'alerts', token: 'TK' })).toEqual({
      topic: 'alerts',
      server: 'https://ntfy.sh',
      token: 'TK',
    })
    expect(
      parseChannelConfig('gotify', {
        server: 'https://gotify.example.com',
        token: 'GT',
        priority: 9,
        apiBaseUrl: 'http://127.0.0.1:8080',
      }),
    ).toEqual({
      server: 'https://gotify.example.com',
      token: 'GT',
      priority: 9,
      apiBaseUrl: 'http://127.0.0.1:8080',
    })
    expect(
      parseChannelConfig('webhook', {
        url: 'https://example.com/hook',
        method: 'PUT',
        headers: { 'x-token': 'abc' },
        template: '{"text":"{{status}}"}',
      }),
    ).toEqual({
      url: 'https://example.com/hook',
      method: 'PUT',
      headers: { 'x-token': 'abc' },
      template: '{"text":"{{status}}"}',
    })
  })

  it('strips unknown keys', () => {
    const parsed = parseChannelConfig('telegram', {
      botToken: 'TOK',
      chatId: '42',
      injected: 'nope',
      apiBaseUrl: 'https://api.telegram.org',
    })
    expect(parsed).toEqual({
      botToken: 'TOK',
      chatId: '42',
      apiBaseUrl: 'https://api.telegram.org',
    })
    expect('injected' in parsed).toBe(false)
  })

  it('rejects invalid configs with a ZodError', () => {
    const invalids: Array<[label: string, type: ChannelType, raw: unknown]> = [
      ['telegram without botToken', 'telegram', { chatId: '42' }],
      ['telegram with empty chatId', 'telegram', { botToken: 'TOK', chatId: '' }],
      [
        'telegram with non-http apiBaseUrl',
        'telegram',
        { botToken: 'TOK', chatId: '42', apiBaseUrl: 'ftp://x' },
      ],
      ['discord without webhookUrl', 'discord', {}],
      ['discord with non-url webhookUrl', 'discord', { webhookUrl: 'not-a-url' }],
      ['slack without webhookUrl', 'slack', {}],
      ['email without smtpHost', 'email', { from: 'a@b.c', to: 'd@e.f' }],
      ['email without to', 'email', { smtpHost: 'smtp.example.com', from: 'a@b.c' }],
      ['email with port 0', 'email', { smtpHost: 's', from: 'a@b.c', to: 'd@e.f', smtpPort: 0 }],
      [
        'email with unknown transport',
        'email',
        { smtpHost: 's', from: 'a@b.c', to: 'd@e.f', transport: 'sendmail' },
      ],
      ['resend without apiKey', 'resend', { from: 'a@b.c', to: 'd@e.f' }],
      ['resend with empty apiKey', 'resend', { apiKey: '', from: 'a@b.c', to: 'd@e.f' }],
      ['resend without from', 'resend', { apiKey: 're_123', to: 'd@e.f' }],
      ['resend without to', 'resend', { apiKey: 're_123', from: 'a@b.c' }],
      [
        'resend with non-http apiBaseUrl',
        'resend',
        { apiKey: 're_123', from: 'a@b.c', to: 'd@e.f', apiBaseUrl: 'ftp://x' },
      ],
      ['ntfy without topic', 'ntfy', {}],
      ['ntfy with empty topic', 'ntfy', { topic: '' }],
      ['ntfy with bad server', 'ntfy', { topic: 't', server: 'nope' }],
      ['gotify without token', 'gotify', { server: 'https://gotify.example.com' }],
      [
        'gotify with non-http server',
        'gotify',
        { server: 'wss://gotify.example.com', token: 'GT' },
      ],
      [
        'gotify with fractional priority',
        'gotify',
        { server: 'https://gotify.example.com', token: 'GT', priority: 1.5 },
      ],
      ['webhook without url', 'webhook', {}],
      ['webhook with unknown method', 'webhook', { url: 'https://example.com', method: 'DELETE' }],
      [
        'webhook with non-string header',
        'webhook',
        { url: 'https://example.com', headers: { a: 1 } },
      ],
    ]
    for (const [label, type, raw] of invalids) {
      expect(() => parseChannelConfig(type, raw), label).toThrow(ZodError)
    }
  })

  it('rejects unknown channel types', () => {
    const type: string = 'sms'
    expect(() => parseChannelConfig(type as ChannelType, {})).toThrow(
      /unsupported channel type: sms/,
    )
  })
})
