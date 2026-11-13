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
export const resendConfigSchema = z.object({
  apiKey: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  /** Overrides the API host — used by tests to point at a local server. */
  apiBaseUrl: httpUrl.default('https://api.resend.com'),
})

export const channelConfigSchemas = {
  resend: resendConfigSchema,
} as const

export type ResendConfig = z.infer<typeof resendConfigSchema>

export interface ChannelConfigMap {
  resend: ResendConfig
}

export type ChannelConfig = ChannelConfigMap[ChannelType]

/**
 * Validate a raw channel config of the given type: defaults are applied and
 * unknown keys stripped. Throws a `ZodError` on invalid input and an `Error`
 * for types that no longer exist (ADR-0007).
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
