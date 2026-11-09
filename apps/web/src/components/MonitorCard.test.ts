import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MonitorCard from './MonitorCard.vue'
import type { Monitor } from '../api.js'

function monitor(overrides: Partial<Monitor> = {}): Monitor {
  return {
    id: 1,
    type: 'http',
    name: 'api',
    active: true,
    isPublic: false,
    intervalS: 60,
    retries: 1,
    retryIntervalS: 60,
    config: { url: 'https://example.com/', method: 'GET', timeoutMs: 10_000 },
    tags: [],
    channelIds: [],
    ...overrides,
  } as unknown as Monitor
}

function mountCard(m: Monitor) {
  return mount(MonitorCard, {
    props: { monitor: m },
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  })
}

describe('MonitorCard', () => {
  it('shows the latest latency while up', () => {
    const wrapper = mountCard(
      monitor({
        latestHeartbeat: { monitorId: 1, status: 'up', latencyMs: 120, responseSnippet: null, time: new Date().toISOString() },
      }),
    )
    const latency = wrapper.findAll('.meta-item').find((item) => item.text().startsWith('Latency'))
    expect(latency?.text()).toContain('120 ms')
  })

  it('shows no latency while down — the failed check’s elapsed time is not a sample', () => {
    const wrapper = mountCard(
      monitor({
        latestHeartbeat: { monitorId: 1, status: 'down', latencyMs: 10_000, responseSnippet: null, time: new Date().toISOString() },
      }),
    )
    const latency = wrapper.findAll('.meta-item').find((item) => item.text().startsWith('Latency'))
    expect(latency?.text()).toContain('—')
    expect(latency?.text()).not.toContain('10.00 s')
  })

  it('never renders a future last check', () => {
    // 30 s of clock skew must not produce "30s from now".
    const wrapper = mountCard(
      monitor({
        latestHeartbeat: {
          monitorId: 1,
          status: 'up',
          latencyMs: 10,
          responseSnippet: null,
          time: new Date(Date.now() + 30_000).toISOString(),
        },
      }),
    )
    const lastCheck = wrapper.findAll('.meta-item').find((item) => item.text().startsWith('Last check'))
    expect(lastCheck?.text()).not.toContain('from now')
  })
})
