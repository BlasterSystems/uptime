import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ResponseChart from './ResponseChart.vue'
import type { LatencyPoint } from './types.js'

const points: LatencyPoint[] = [
  { time: 1_000, latencyMs: 100 },
  { time: 2_000, latencyMs: 200 },
  { time: 3_000, latencyMs: 150 },
]

function mountChart(plotPoints: LatencyPoint[]) {
  const wrapper = mount(ResponseChart, {
    props: {
      points: plotPoints,
      domain:
        plotPoints.length === 0
          ? null
          : { min: plotPoints[0]!.time, max: plotPoints[plotPoints.length - 1]!.time },
    },
  })
  const svg = wrapper.find('svg').element
  // jsdom reports a zero rect; the chart scales clientX by the rect width.
  svg.getBoundingClientRect = () =>
    ({
      width: 720,
      height: 200,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 720,
      bottom: 200,
      toJSON: () => ({}),
    }) as DOMRect
  return wrapper
}

describe('ResponseChart hover', () => {
  it('shows the nearest point value and follows the pointer', async () => {
    const wrapper = mountChart(points)
    const svg = wrapper.find('svg')
    expect(wrapper.find('.chart-hover').exists()).toBe(false)

    // Middle of the plot resolves to the middle point.
    await svg.trigger('pointermove', { clientX: 360 })
    expect(wrapper.find('.chart-hover').exists()).toBe(true)
    expect(wrapper.find('.hover-text').text()).toContain('200 ms')

    // Moving to the left edge re-resolves to the first point.
    await svg.trigger('pointermove', { clientX: 0 })
    expect(wrapper.find('.hover-text').text()).toContain('100 ms')

    await svg.trigger('pointerleave')
    expect(wrapper.find('.chart-hover').exists()).toBe(false)
  })

  it('stays hidden without points', async () => {
    const wrapper = mountChart([])
    await wrapper.find('svg').trigger('pointermove', { clientX: 100 })
    expect(wrapper.find('.chart-hover').exists()).toBe(false)
    expect(wrapper.find('.chart-note').exists()).toBe(true)
  })
})
