import { describe, expect, it } from 'vitest'
import { escapeHtml, humanDuration, renderEmailFrame, renderNotifyEmail } from './templates.js'
import type { NotifyPayload } from './types.js'

const base: NotifyPayload = {
  title: 'Example is down',
  body: 'Connection refused',
  monitorName: 'Example',
  status: 'down',
  latencyMs: 42,
  downtimeMs: null,
  tags: ['prod', 'api'],
}

describe('humanDuration', () => {
  it('formats compact durations', () => {
    expect(humanDuration(5000)).toBe('5s')
    expect(humanDuration(252_000)).toBe('4m 12s')
    expect(humanDuration(3_661_000)).toBe('1h 1m 1s')
    expect(humanDuration(-1)).toBe('0s')
  })
})

describe('escapeHtml', () => {
  it('escapes text and attribute contexts', () => {
    expect(escapeHtml('a&b<c>"d\'e')).toBe('a&amp;b&lt;c&gt;&quot;d&#39;e')
  })
})

describe('renderEmailFrame', () => {
  it('renders the vermilion alarm line and diamond for down states', () => {
    const { html } = renderEmailFrame({
      eyebrow: 'Uptime monitor',
      heading: 'A is DOWN',
      accent: 'down',
      detail: 'connect: refused',
    })
    expect(html).toContain('height:2px;background-color:#da452c')
    expect(html).toContain('◆')
    expect(html).not.toContain('#161b22;font-size:0')
  })

  it('renders the ink line and square for up states, never vermilion', () => {
    const { html } = renderEmailFrame({ eyebrow: 'Uptime monitor', heading: 'A is back UP' })
    expect(html).toContain('height:2px;background-color:#161b22')
    expect(html).not.toContain('#da452c')
  })

  it('escapes every interpolated value', () => {
    const { html } = renderEmailFrame({
      eyebrow: 'Uptime monitor',
      heading: '<b>T</b>',
      body: '<script>x</script>',
    })
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>T</b>')
  })

  it('keeps the plain-text part aligned and label-led', () => {
    const { text } = renderEmailFrame({
      eyebrow: 'Uptime monitor',
      heading: 'A is DOWN',
      detail: 'connect: refused',
      rows: [
        { label: 'Latency', value: '42 ms' },
        { label: 'Downtime', value: '4m 12s' },
      ],
      chips: ['prod', 'api'],
    })
    expect(text).toBe(
      'A is DOWN\n\nconnect: refused\n\nLatency:  42 ms\nDowntime: 4m 12s\n\nTags: prod, api',
    )
  })

  it('renders a bulletproof action with escaped href, fallback and note', () => {
    const { html, text } = renderEmailFrame({
      eyebrow: 'Security',
      heading: 'Reset your password',
      action: {
        label: 'Choose a new password',
        url: 'https://x.test/reset?token=a&b=c',
        fallbackUrl: 'https://x.test/reset?token=a&b=c',
        note: 'If you did not request a reset, ignore this email.',
      },
    })
    expect(html).toContain('href="https://x.test/reset?token=a&amp;b=c"')
    expect(html.match(/https:\/\/x\.test\/reset/g)).toHaveLength(2)
    expect(text).toContain('https://x.test/reset?token=a&b=c')
  })
})

describe('renderNotifyEmail', () => {
  it('renders down alerts with the mono detail block and data rows', () => {
    const { html, text } = renderNotifyEmail({ ...base, downtimeMs: 252_000 })
    expect(html).toContain('height:2px;background-color:#da452c')
    expect(html).toContain('Example is down')
    expect(html).toContain('Connection refused')
    expect(html).toContain('>Latency<')
    expect(html).toContain('42 ms')
    expect(html).toContain('>Downtime<')
    expect(html).toContain('4m 12s')
    expect(html).toContain('Uptime monitor')
    expect(text).toContain('Connection refused')
    expect(text).toContain('Latency:  42 ms')
  })

  it('reports consecutive failures only when present', () => {
    const withFailures = renderNotifyEmail({ ...base, failures: 2 })
    expect(withFailures.html).toContain('>Consecutive failures<')
    expect(withFailures.html).toContain('>2<')
    expect(renderNotifyEmail(base).html).not.toContain('Consecutive failures')
  })

  it('renders recovery as prose with the ink accent', () => {
    const { html } = renderNotifyEmail({
      ...base,
      title: 'Example is back UP',
      status: 'up',
      body: 'Recovered after 4m 12s (42 ms).',
      downtimeMs: 252_000,
    })
    expect(html).toContain('height:2px;background-color:#161b22')
    expect(html).toContain('Recovered after 4m 12s (42 ms).')
    expect(html).not.toContain('#da452c')
    expect(html).not.toContain('repeat')
  })

  it('labels status-page payloads with the event and keeps the body prose', () => {
    const { html, text } = renderNotifyEmail({
      ...base,
      title: 'acme status: EU edge API unavailable',
      body: 'Investigating elevated 5xx rates.',
      latencyMs: null,
      tags: ['status-page', 'incident_open'],
    })
    expect(html).toContain('Status page')
    expect(html).toContain('incident opened')
    expect(html).toContain('Investigating elevated 5xx rates.')
    expect(text).toContain('Event: incident opened')
  })

  it('keeps maintenance events on the ink accent even while degraded', () => {
    const { html } = renderNotifyEmail({
      ...base,
      title: 'acme status: maintenance started for EU edge',
      body: 'Scheduled maintenance is in progress for EU edge.',
      tags: ['status-page', 'maintenance_start'],
    })
    expect(html).toContain('height:2px;background-color:#161b22')
    expect(html).not.toContain('#da452c')
    expect(html).toContain('maintenance started')
  })

  it('marks repeat notifications', () => {
    const { html } = renderNotifyEmail({ ...base, downtimeMs: 60_000 })
    expect(html).toContain('Uptime monitor · repeat')
  })

  it('hides the latency row for the push sentinel', () => {
    const { html } = renderNotifyEmail({ ...base, latencyMs: 0 })
    expect(html).not.toContain('>Latency<')
  })
})
