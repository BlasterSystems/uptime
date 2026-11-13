import { parseChannelConfig } from './config.js'
import type { ResendConfig } from './config.js'
import type { ChannelType, NotifyPayload } from './types.js'

/** JSON request with the shared non-2xx handling: status + first 200 chars. */
async function sendJson(
  provider: string,
  url: string,
  body: unknown,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<void> {
  const response = await fetch(url, {
    method: options.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify(body),
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new Error(`${provider} responded with ${response.status}: ${text.slice(0, 200)}`)
  }
}

/** Request body used by {@link sendResend}; exported for direct assertions. */
export function buildResendMessage(config: ResendConfig, payload: NotifyPayload): {
  from: string
  to: string[]
  subject: string
  text: string
} {
  return { from: config.from, to: [config.to], subject: payload.title, text: payload.body }
}

export async function sendResend(config: ResendConfig, payload: NotifyPayload): Promise<void> {
  const base = config.apiBaseUrl.replace(/\/+$/, '')
  await sendJson('resend', `${base}/emails`, buildResendMessage(config, payload), {
    headers: { authorization: `Bearer ${config.apiKey}` },
  })
}

/** Validate a raw channel config and deliver `payload` through its provider. */
export async function sendToChannel(
  type: ChannelType,
  config: unknown,
  payload: NotifyPayload,
): Promise<void> {
  switch (type) {
    case 'resend':
      return sendResend(parseChannelConfig('resend', config), payload)
    default:
      // Rows of providers removed by ADR-0007 can only linger pre-migration.
      throw new Error(`unsupported channel type: ${String(type)}`)
  }
}
