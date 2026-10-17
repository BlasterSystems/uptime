/** Notification provider types (SPEC §7). */
export const CHANNEL_TYPES = [
  'telegram',
  'discord',
  'slack',
  'email',
  'resend',
  'ntfy',
  'gotify',
  'webhook',
] as const

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
}
