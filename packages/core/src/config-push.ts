import { z } from 'zod'

/**
 * Validated configuration of a `push` monitor (SPEC §3): the monitor is driven by
 * heartbeats posted to its token receiver, not by the scheduler.
 */
export interface PushMonitorConfig {
  /** Silence tolerance on top of the monitor interval before an incident opens. */
  graceSeconds: number
  /** Optional cron schedule (`* * * * *` or `* * * * * *`) for jobs expected at a time. */
  cron?: string
  /** Require a heartbeat body (Healthchecks-style caller log capture). */
  expectsBody?: boolean
}

/** Default silence tolerance in seconds (SPEC §3). */
const DEFAULT_GRACE_SECONDS = 60

/**
 * Charset accepted per cron field: digits plus `*`, `/`, `,`, `-`. Full semantics
 * (ranges, steps, aliases, timezone) are validated when the schedule runner lands.
 */
const CRON_FIELD_PATTERN = /^[0-9*/,-]+$/

const cronSchema = z.string().refine((value) => {
  const fields = value.trim().split(/\s+/)
  return (
    (fields.length === 5 || fields.length === 6) &&
    fields.every((field) => CRON_FIELD_PATTERN.test(field))
  )
}, 'cron must be 5 or 6 whitespace-separated fields matching [0-9*/,-]')

/**
 * Zod schema for {@link PushMonitorConfig}, including its default `graceSeconds: 60`.
 * Unknown keys are stripped, matching the `http` schema.
 */
export const pushMonitorConfigSchema = z.object({
  graceSeconds: z.int().min(1).default(DEFAULT_GRACE_SECONDS),
  cron: cronSchema.optional(),
  expectsBody: z.boolean().optional(),
})
