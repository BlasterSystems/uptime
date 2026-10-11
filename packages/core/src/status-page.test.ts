import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { componentStatus, overallStatus, parseStatusPageStructure } from './status-page.js'
import type { ComponentMonitorState, StatusPageComponent } from './status-page.js'
import type { HeartbeatStatus } from './types.js'

const component = (overrides: Partial<StatusPageComponent> = {}): StatusPageComponent => ({
  id: 'api',
  label: 'API',
  monitorIds: [1],
  ...overrides,
})

const state = (
  status: HeartbeatStatus,
  latencyMs: number | null = null,
  inMaintenance = false,
): ComponentMonitorState => ({ monitorId: 1, status, latencyMs, inMaintenance })

describe('parseStatusPageStructure', () => {
  it('applies the documented defaults', () => {
    const parsed = parseStatusPageStructure({
      groups: [{ name: 'Core', components: [{ id: 'api', label: 'API', monitorIds: [1, 2] }] }],
    })
    expect(parsed).toEqual({
      groups: [
        {
          name: 'Core',
          components: [
            {
              id: 'api',
              label: 'API',
              monitorIds: [1, 2],
              aggregation: 'worst',
              showUptime: true,
              showChart: false,
            },
          ],
        },
      ],
      autoPublish: true,
    })
  })

  it('keeps a fully specified structure intact', () => {
    const raw = {
      groups: [
        {
          name: 'Async workers',
          components: [
            {
              id: 'worker-fleet',
              label: 'Worker fleet',
              description: 'Shared queue consumers',
              monitorIds: [3, 4, 5],
              aggregation: 'any',
              degradedLatencyMs: 1500,
              showUptime: false,
              showChart: true,
            },
          ],
        },
      ],
      degradedLatencyMs: 800,
      autoPublish: false,
    }
    expect(parseStatusPageStructure(raw)).toEqual(raw)
  })

  it('accepts boundary lengths', () => {
    const parsed = parseStatusPageStructure({
      groups: [
        {
          name: 'Core',
          components: [
            {
              id: 'a'.repeat(60),
              label: 'a'.repeat(120),
              description: 'ok',
              monitorIds: [1],
            },
          ],
        },
      ],
    })
    expect(parsed.groups[0]?.components[0]?.id).toBe('a'.repeat(60))
    expect(parsed.groups[0]?.components[0]?.label).toBe('a'.repeat(120))
    expect(parsed.groups[0]?.components[0]?.description).toBe('ok')
  })

  it('strips unknown keys everywhere', () => {
    const parsed = parseStatusPageStructure({
      theme: 'dark',
      groups: [
        {
          name: 'Core',
          color: 'red',
          components: [{ id: 'api', label: 'API', monitorIds: [1], icon: 'bolt' }],
        },
      ],
    })
    expect(parsed).toEqual({
      groups: [
        {
          name: 'Core',
          components: [
            {
              id: 'api',
              label: 'API',
              monitorIds: [1],
              aggregation: 'worst',
              showUptime: true,
              showChart: false,
            },
          ],
        },
      ],
      autoPublish: true,
    })
    expect(parsed).not.toHaveProperty('theme')
    expect(parsed.groups[0]).not.toHaveProperty('color')
    expect(parsed.groups[0]?.components[0]).not.toHaveProperty('icon')
  })

  it('accepts empty groups', () => {
    expect(parseStatusPageStructure({ groups: [] })).toEqual({ groups: [], autoPublish: true })
  })

  it('accepts the empty object stored for a new page', () => {
    // `status_pages.structure` defaults to '{}' in the database.
    expect(parseStatusPageStructure({})).toEqual({ groups: [], autoPublish: true })
  })

  it('rejects invalid structures with a ZodError', () => {
    const withComponent = (raw: Record<string, unknown>): unknown => ({
      groups: [{ name: 'Core', components: [raw] }],
    })
    const invalids: Array<[label: string, raw: unknown]> = [
      ['null', null],
      ['a bare string', 'groups'],
      ['a number', 7],
      ['groups not a list', { groups: 'Core' }],
      ['empty group name', { groups: [{ name: '', components: [] }] }],
      ['group without a name', { groups: [{ components: [] }] }],
      ['component without monitorIds', withComponent({ id: 'api', label: 'API' })],
      ['empty monitorIds', withComponent({ id: 'api', label: 'API', monitorIds: [] })],
      ['zero monitor id', withComponent({ id: 'api', label: 'API', monitorIds: [0] })],
      ['fractional monitor id', withComponent({ id: 'api', label: 'API', monitorIds: [1.5] })],
      ['uppercase id', withComponent({ id: 'API', label: 'API', monitorIds: [1] })],
      ['id with an underscore', withComponent({ id: 'api_v1', label: 'API', monitorIds: [1] })],
      ['id over 60 chars', withComponent({ id: 'a'.repeat(61), label: 'API', monitorIds: [1] })],
      ['empty label', withComponent({ id: 'api', label: '', monitorIds: [1] })],
      [
        'label over 120 chars',
        withComponent({ id: 'api', label: 'a'.repeat(121), monitorIds: [1] }),
      ],
      [
        'non-string description',
        withComponent({ id: 'api', label: 'API', monitorIds: [1], description: 7 }),
      ],
      [
        'unknown aggregation',
        withComponent({ id: 'api', label: 'API', monitorIds: [1], aggregation: 'first' }),
      ],
      [
        'negative component threshold',
        withComponent({ id: 'api', label: 'API', monitorIds: [1], degradedLatencyMs: -1 }),
      ],
      [
        'zero component threshold',
        withComponent({ id: 'api', label: 'API', monitorIds: [1], degradedLatencyMs: 0 }),
      ],
      [
        'fractional component threshold',
        withComponent({ id: 'api', label: 'API', monitorIds: [1], degradedLatencyMs: 12.5 }),
      ],
      ['negative page threshold', { groups: [], degradedLatencyMs: -5 }],
      ['non-boolean autoPublish', { groups: [], autoPublish: 'yes' }],
    ]
    for (const [label, raw] of invalids) {
      expect(() => parseStatusPageStructure(raw), label).toThrow(ZodError)
    }
  })
})

describe('componentStatus', () => {
  it('is unknown without monitor states', () => {
    expect(componentStatus(component(), [])).toBe('unknown')
  })

  it('is maintenance when every monitor is in a maintenance window', () => {
    expect(componentStatus(component(), [state('maintenance', null, true)])).toBe('maintenance')
    expect(
      componentStatus(component(), [state('down', 120, true), state('maintenance', null, true)]),
    ).toBe('maintenance')
  })

  it('is maintenance for mixed maintenance + up monitors', () => {
    expect(componentStatus(component(), [state('maintenance', null, true), state('up', 42)])).toBe(
      'maintenance',
    )
  })

  it('treats a maintenance heartbeat as in maintenance without the window flag', () => {
    expect(componentStatus(component(), [state('maintenance'), state('up', 42)])).toBe(
      'maintenance',
    )
  })

  it('does not let maintenance mask an actual outage', () => {
    expect(componentStatus(component(), [state('maintenance', 10, true), state('down', 10)])).toBe(
      'partial_outage',
    )
    expect(
      componentStatus(component({ aggregation: 'any' }), [
        state('maintenance', 10, true),
        state('down', 10),
        state('down', 10),
      ]),
    ).toBe('operational')
  })

  it('is a major outage when every monitor is down', () => {
    expect(componentStatus(component(), [state('down'), state('down')])).toBe('major_outage')
    expect(componentStatus(component({ aggregation: 'any' }), [state('down'), state('down')])).toBe(
      'major_outage',
    )
  })

  it('is a partial outage when some monitors are down and aggregation is worst', () => {
    expect(componentStatus(component(), [state('up', 10), state('down')])).toBe('partial_outage')
    expect(componentStatus(component(), [state('pending'), state('down'), state('up', 10)])).toBe(
      'partial_outage',
    )
  })

  it("stays up while one monitor is not down when aggregation is 'any'", () => {
    expect(
      componentStatus(component({ aggregation: 'any' }), [state('up', 10), state('down')]),
    ).toBe('operational')
    expect(
      componentStatus(component({ aggregation: 'any' }), [state('pending'), state('down')]),
    ).toBe('operational')
  })

  it('is degraded when an up monitor exceeds the page latency threshold', () => {
    expect(componentStatus(component(), [state('up', 600), state('up', 120)], 500)).toBe('degraded')
  })

  it('lets the component threshold override the page threshold', () => {
    expect(componentStatus(component({ degradedLatencyMs: 1000 }), [state('up', 700)], 500)).toBe(
      'operational',
    )
    expect(componentStatus(component({ degradedLatencyMs: 300 }), [state('up', 400)], 1000)).toBe(
      'degraded',
    )
  })

  it('is not degraded when latency equals the threshold', () => {
    expect(componentStatus(component(), [state('up', 500)], 500)).toBe('operational')
    expect(componentStatus(component({ degradedLatencyMs: 500 }), [state('up', 500)])).toBe(
      'operational',
    )
  })

  it('ignores latency without a positive threshold', () => {
    expect(componentStatus(component(), [state('up', 9999)])).toBe('operational')
    expect(componentStatus(component({ degradedLatencyMs: 0 }), [state('up', 9999)])).toBe(
      'operational',
    )
  })

  it('ignores the latency of down monitors', () => {
    expect(
      componentStatus(
        component({ aggregation: 'any' }),
        [state('down', 9999), state('up', 100)],
        500,
      ),
    ).toBe('operational')
  })

  it('prefers the availability verdict over the latency verdict', () => {
    expect(componentStatus(component(), [state('down', 9999), state('up', 9999)], 500)).toBe(
      'partial_outage',
    )
  })

  it("falls through to latency when a down monitor is compensated under 'any'", () => {
    expect(
      componentStatus(
        component({ aggregation: 'any' }),
        [state('down', 9999), state('up', 9999)],
        500,
      ),
    ).toBe('degraded')
  })

  it('is unknown while every monitor is pending', () => {
    expect(componentStatus(component(), [state('pending')])).toBe('unknown')
    expect(componentStatus(component(), [state('pending'), state('pending')])).toBe('unknown')
  })

  it('handles a single monitor the same way under both aggregations', () => {
    expect(componentStatus(component(), [state('up', 10)])).toBe('operational')
    expect(componentStatus(component({ aggregation: 'any' }), [state('up', 10)])).toBe(
      'operational',
    )
    expect(componentStatus(component(), [state('down')])).toBe('major_outage')
    expect(componentStatus(component({ aggregation: 'any' }), [state('down')])).toBe('major_outage')
  })
})

describe('overallStatus', () => {
  it('is unknown for an empty component list', () => {
    expect(overallStatus([])).toBe('unknown')
  })

  it('is operational when every component is operational', () => {
    expect(overallStatus(['operational', 'operational'])).toBe('operational')
  })

  it('applies the severity precedence', () => {
    expect(overallStatus(['operational', 'degraded'])).toBe('degraded')
    expect(overallStatus(['degraded', 'partial_outage'])).toBe('partial_outage')
    expect(overallStatus(['partial_outage', 'major_outage'])).toBe('major_outage')
    expect(overallStatus(['maintenance', 'degraded'])).toBe('degraded')
    expect(overallStatus(['unknown', 'maintenance'])).toBe('maintenance')
    expect(overallStatus(['operational', 'unknown'])).toBe('unknown')
    expect(overallStatus(['unknown', 'partial_outage', 'maintenance'])).toBe('partial_outage')
    expect(
      overallStatus(['unknown', 'operational', 'degraded', 'partial_outage', 'major_outage']),
    ).toBe('major_outage')
  })
})
