import { describe, expect, it } from 'vitest'
import { renderTemplate } from './template.js'
import type { NotifyPayload } from './types.js'

const payload: NotifyPayload = {
  title: 'Monitor is down',
  body: 'Example is down',
  monitorName: 'Example',
  status: 'down',
  latencyMs: 123,
  downtimeMs: 252_000,
  tags: ['prod', 'api'],
}

describe('renderTemplate', () => {
  it('replaces every supported placeholder', () => {
    expect(
      renderTemplate('{{monitor.name}} {{status}} {{latency}} {{downtime}} {{tags}}', payload),
    ).toBe('Example down 123 ms 4m 12s prod, api')
  })

  it('tolerates whitespace inside the braces', () => {
    expect(renderTemplate('{{ monitor.name }} is {{ status }}', payload)).toBe('Example is down')
  })

  it('renders null latency and downtime as "-"', () => {
    expect(
      renderTemplate('{{latency}} / {{downtime}}', {
        ...payload,
        latencyMs: null,
        downtimeMs: null,
      }),
    ).toBe('- / -')
  })

  it('renders an empty tag list as an empty string', () => {
    expect(renderTemplate('[{{tags}}]', { ...payload, tags: [] })).toBe('[]')
  })

  it('replaces unknown placeholders with an empty string', () => {
    expect(renderTemplate('a{{nope}}b {{monitor.id}}', payload)).toBe('ab ')
  })

  it('returns templates without placeholders unchanged', () => {
    expect(renderTemplate('plain text', payload)).toBe('plain text')
  })

  it('formats durations with at most two units', () => {
    const render = (downtimeMs: number) =>
      renderTemplate('{{downtime}}', { ...payload, downtimeMs })
    expect(render(0)).toBe('0s')
    expect(render(45_000)).toBe('45s')
    expect(render(3_600_000)).toBe('1h')
    expect(render(7_260_000)).toBe('2h 1m')
    expect(render(90_000_000)).toBe('1d 1h')
    expect(render(-1)).toBe('-')
  })
})
