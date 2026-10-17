import { z } from 'zod'
import type { ChannelType } from './types.js'

const httpUrl = z.string().refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}, 'url must be a valid http(s) URL')

/**
 * Per-type channel config schemas. Zod strips unknown keys, so `parse` both
 * applies the documented defaults and narrows the shape before storage.
 */
export const telegramConfigSchema = z.object({
  botToken: z.string().min(1),
  chatId: z.union([z.string().min(1), z.int()]),
  apiBaseUrl: httpUrl.default('https://api.telegram.org'),
})

export const discordConfigSchema = z.object({
  webhookUrl: httpUrl,
  /** Overrides the webhook host — used by tests to point at a local server. */
  apiBaseUrl: httpUrl.optional(),
})

export const slackConfigSchema = z.object({
  webhookUrl: httpUrl,
  /** Overrides the webhook host — used by tests to point at a local server. */
  apiBaseUrl: httpUrl.optional(),
})

export const emailConfigSchema = z.object({
  smtpHost: z.string().min(1),
  smtpPort: z.int().positive().default(587),
  secure: z.boolean().default(false),
  username: z.string().optional(),
  password: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  /** `json` uses nodemailer's jsonTransport instead of a real SMTP connection. */
  transport: z.enum(['smtp', 'json']).default('smtp'),
})

export const resendConfigSchema = z.object({
  apiKey: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  /** Overrides the API host — used by tests to point at a local server. */
  apiBaseUrl: httpUrl.default('https://api.resend.com'),
})

export const ntfyConfigSchema = z.object({
  topic: z.string().min(1),
  server: httpUrl.default('https://ntfy.sh'),
  token: z.string().min(1).optional(),
})

export const gotifyConfigSchema = z.object({
  server: httpUrl,
  token: z.string().min(1),
  priority: z.int().default(5),
  /** Overrides the server host — used by tests to point at a local server. */
  apiBaseUrl: httpUrl.optional(),
})

export const webhookConfigSchema = z.object({
  url: httpUrl,
  method: z.enum(['POST', 'PUT']).default('POST'),
  headers: z.record(z.string(), z.string()).optional(),
  /** Mustache-lite body template; the rendered result is parsed as JSON. */
  template: z.string().optional(),
})

export const channelConfigSchemas = {
  telegram: telegramConfigSchema,
  discord: discordConfigSchema,
  slack: slackConfigSchema,
  email: emailConfigSchema,
  resend: resendConfigSchema,
  ntfy: ntfyConfigSchema,
  gotify: gotifyConfigSchema,
  webhook: webhookConfigSchema,
} as const

export type TelegramConfig = z.infer<typeof telegramConfigSchema>
export type DiscordConfig = z.infer<typeof discordConfigSchema>
export type SlackConfig = z.infer<typeof slackConfigSchema>
export type EmailConfig = z.infer<typeof emailConfigSchema>
export type ResendConfig = z.infer<typeof resendConfigSchema>
export type NtfyConfig = z.infer<typeof ntfyConfigSchema>
export type GotifyConfig = z.infer<typeof gotifyConfigSchema>
export type WebhookConfig = z.infer<typeof webhookConfigSchema>

export interface ChannelConfigMap {
  telegram: TelegramConfig
  discord: DiscordConfig
  slack: SlackConfig
  email: EmailConfig
  resend: ResendConfig
  ntfy: NtfyConfig
  gotify: GotifyConfig
  webhook: WebhookConfig
}

export type ChannelConfig = ChannelConfigMap[ChannelType]

/**
 * Validate a raw channel config of the given type: defaults are applied and
 * unknown keys stripped. Throws a `ZodError` on invalid input.
 */
export function parseChannelConfig<T extends ChannelType>(
  type: T,
  raw: unknown,
): ChannelConfigMap[T] {
  const schema: z.ZodType | undefined = (
    channelConfigSchemas as Partial<Record<string, z.ZodType>>
  )[type]
  if (schema === undefined) throw new Error(`unsupported channel type: ${String(type)}`)
  return schema.parse(raw) as ChannelConfigMap[T]
}
