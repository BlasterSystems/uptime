/** Notification provider types (SPEC §7). */
export const CHANNEL_TYPES = ['resend'] as const

export type ChannelType = (typeof CHANNEL_TYPES)[number]

/** Payload handed to every provider for a monitor event. */
export interface NotifyPayload {
  title: string
  body: string
  monitorName: string
  status: 'up' | 'down'
  latencyMs: number | null
  downtimeMs: number | null
  tags: string[]
  /** Consecutive failed checks at send time; set on down alerts, absent otherwise. */
  failures?: number
}
