/** Formatting helpers shared by the dashboard, incident table and settings views. */

/** Compact "time ago" label, e.g. `12s ago`, `4m ago`, `3d ago`. */
export function relativeTime(iso: string, now = Date.now()): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return 'unknown'
  const seconds = Math.round((now - timestamp) / 1000)
  if (Math.abs(seconds) < 5) return 'just now'
  const amount = Math.abs(seconds)
  const suffix = seconds >= 0 ? 'ago' : 'from now'
  if (amount < 60) return `${amount}s ${suffix}`
  const minutes = Math.floor(amount / 60)
  if (minutes < 60) return `${minutes}m ${suffix}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${suffix}`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ${suffix}`
  return formatDateTime(iso)
}

/** Human duration, e.g. `45s`, `3m 20s`, `2h 5m`, `1d 3h`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 1) return 'under 1s'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
  }
  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`
}

export function formatDateTime(iso: string): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return 'unknown'
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/** `HH:MM` in the viewer's locale — chart hover labels. Accepts epoch ms. */
export function formatClock(time: number): string {
  if (!Number.isFinite(time)) return '—'
  return new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** Interval/latency length, e.g. `60s`, `5m`, `120 ms`. */
export function formatInterval(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = minutes / 60
  return hours % 1 === 0 ? `${hours}h` : `${hours.toFixed(1)}h`
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}
