<script setup lang="ts">
import { computed } from 'vue'
import { formatLatency } from '../../format.js'
import type { ChartMarker, LatencyPoint } from './types.js'

/**
 * Inline-SVG response-time chart: one polyline through the successful checks
 * plus a tick per down/maintenance beat. Extracted from the monitor detail
 * view so public status-page components can reuse it.
 */
const props = withDefaults(
  defineProps<{
    points: readonly LatencyPoint[]
    markers?: readonly ChartMarker[]
    /** Explicit time domain in epoch ms; defaults to the plotted beats' span. */
    domain?: { min: number; max: number } | null
    ariaLabel?: string
    startLabel?: string
    endLabel?: string
    /** Shown instead of the line when no successful check can be plotted. */
    emptyText?: string
  }>(),
  {
    markers: () => [],
    domain: null,
    ariaLabel: 'Response time chart',
    startLabel: '24h ago',
    endLabel: 'now',
    emptyText: 'No successful checks in the last 24 hours.',
  },
)

/** Chart geometry shared by the template and the scale helpers. */
const CHART_WIDTH = 720
const CHART_HEIGHT = 200
const CHART_PAD_X = 14
const CHART_PAD_TOP = 16
const CHART_PAD_BOTTOM = 34
const CHART_PLOT_WIDTH = CHART_WIDTH - CHART_PAD_X * 2
const CHART_PLOT_HEIGHT = CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM
const CHART_PLOT_BOTTOM = CHART_HEIGHT - CHART_PAD_BOTTOM

const timeDomain = computed<{ min: number; max: number } | null>(() => {
  if (props.domain !== null) return props.domain
  const times = [
    ...props.points.map((point) => point.time),
    ...props.markers.map((marker) => marker.time),
  ]
  if (times.length === 0) return null
  return { min: Math.min(...times), max: Math.max(...times) }
})

const chart = computed(() => {
  const domain = timeDomain.value
  const peakLatency =
    props.points.length === 0 ? null : Math.max(...props.points.map((point) => point.latencyMs))
  // ~10% headroom above the slowest successful check.
  const yMax = peakLatency === null ? 1 : Math.max(1, peakLatency * 1.1)

  const xAt = (time: number): number => {
    if (domain === null || domain.max === domain.min) {
      return CHART_PAD_X + CHART_PLOT_WIDTH / 2
    }
    return CHART_PAD_X + ((time - domain.min) / (domain.max - domain.min)) * CHART_PLOT_WIDTH
  }

  const yAt = (latencyMs: number): number =>
    CHART_PAD_TOP + (1 - latencyMs / yMax) * CHART_PLOT_HEIGHT

  const polyline = props.points
    .map((point) => `${xAt(point.time).toFixed(1)},${yAt(point.latencyMs).toFixed(1)}`)
    .join(' ')

  const markers = props.markers.map((marker) => ({ ...marker, x: xAt(marker.time) }))

  return { polyline, markers, peakLatency, hasLatency: props.points.length > 0 }
})
</script>

<template>
  <div class="chart-block">
    <svg
      class="chart"
      :viewBox="`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`"
      role="img"
      :aria-label="ariaLabel"
    >
      <line
        class="chart-baseline"
        :x1="CHART_PAD_X"
        :y1="CHART_PLOT_BOTTOM"
        :x2="CHART_WIDTH - CHART_PAD_X"
        :y2="CHART_PLOT_BOTTOM"
      />
      <polyline v-if="chart.polyline !== ''" class="chart-line" :points="chart.polyline" />
      <g v-for="(marker, index) in chart.markers" :key="index">
        <line
          class="chart-marker"
          :class="`marker-${marker.status}`"
          :x1="marker.x"
          :y1="CHART_PLOT_BOTTOM"
          :x2="marker.x"
          :y2="CHART_PLOT_BOTTOM + 10"
        >
          <title>{{ marker.title }}</title>
        </line>
      </g>
    </svg>
    <div class="chart-caption">
      <span>Max {{ formatLatency(chart.peakLatency) }}</span>
      <span>{{ startLabel }}</span>
      <span>{{ endLabel }}</span>
    </div>
  </div>
  <p v-if="!chart.hasLatency" class="chart-note">{{ emptyText }}</p>
</template>

<style scoped>
.chart-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.chart {
  display: block;
  width: 100%;
  height: auto;
}

.chart-baseline {
  stroke: var(--border);
  stroke-width: 1;
}

.chart-line {
  fill: none;
  stroke: var(--thread);
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
}

.chart-marker {
  stroke-linecap: round;
  stroke-width: 2;
}

.marker-down {
  stroke: var(--error);
}

.marker-maintenance {
  stroke: var(--ink-3);
}

.chart-caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  color: var(--ink-3);
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.chart-note {
  color: var(--muted);
  font-size: 12.5px;
}
</style>
