import type { NotifyPayload } from './types.js'

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g

/**
 * Human duration, at most two units: `45s`, `4m 12s`, `2h 1m`, `1d 1h`.
 * Sub-second remainders are floored; invalid values render as `-`.
 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const units: Array<[size: number, label: string]> = [
    [86_400, 'd'],
    [3_600, 'h'],
    [60, 'm'],
    [1, 's'],
  ]
  const parts: string[] = []
  let rest = totalSeconds
  for (const [size, label] of units) {
    const value = Math.floor(rest / size)
    if (value > 0) parts.push(`${value}${label}`)
    rest %= size
    if (parts.length === 2) break
  }
  return parts.join(' ')
}

/**
 * Replaces `{{monitor.name}}`, `{{status}}`, `{{downtime}}`, `{{latency}}` and
 * `{{tags}}` in `template`. Unknown placeholders become an empty string.
 */
export function renderTemplate(template: string, payload: NotifyPayload): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    switch (key) {
      case 'monitor.name':
        return payload.monitorName
      case 'status':
        return payload.status
      case 'downtime':
        return payload.downtimeMs === null ? '-' : formatDuration(payload.downtimeMs)
      case 'latency':
        return payload.latencyMs === null ? '-' : `${payload.latencyMs} ms`
      case 'tags':
        return payload.tags.join(', ')
      default:
        return ''
    }
  })
}
