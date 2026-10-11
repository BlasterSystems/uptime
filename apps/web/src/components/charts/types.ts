/** Shared types for the dependency-free SVG chart components. */

/** One successful check: epoch milliseconds and its measured latency. */
export interface LatencyPoint {
  time: number
  latencyMs: number
}

/** A down or maintenance beat, drawn as a vertical tick under the chart line. */
export interface ChartMarker {
  time: number
  status: 'down' | 'maintenance'
  title: string
}

export type StripTone = 'up' | 'down' | 'pending' | 'maintenance' | 'empty'

/** One cell of the heartbeat strip, already reduced to its final tone. */
export interface StripCell {
  key: string
  tone: StripTone
  title: string
}
