import { createTransport } from 'nodemailer'
import { parseChannelConfig } from './config.js'
import type {
  DiscordConfig,
  EmailConfig,
  GotifyConfig,
  NtfyConfig,
  SlackConfig,
  TelegramConfig,
  WebhookConfig,
} from './config.js'
import { renderTemplate } from './template.js'
import type { ChannelType, NotifyPayload } from './types.js'

/** Single-text providers have no title/body split; keep one composition rule. */
function messageText(payload: NotifyPayload): string {
  return payload.body.length > 0 ? `${payload.title}\n\n${payload.body}` : payload.title
}

/**
 * Replaces the origin of `url` with the origin of `base`, keeping the path and
 * query. Used by provider configs that expose `apiBaseUrl` for local testing.
 */
function withHost(url: string, base: string): string {
  const target = new URL(url)
  const root = new URL(base)
  target.protocol = root.protocol
  target.host = root.host
  return target.toString().replace(/\/+$/, '')
}

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

export async function sendTelegram(config: TelegramConfig, payload: NotifyPayload): Promise<void> {
  const base = config.apiBaseUrl.replace(/\/+$/, '')
  await sendJson('telegram', `${base}/bot${config.botToken}/sendMessage`, {
    chat_id: config.chatId,
    text: messageText(payload),
  })
}

export async function sendDiscord(config: DiscordConfig, payload: NotifyPayload): Promise<void> {
  const url =
    config.apiBaseUrl === undefined
      ? config.webhookUrl
      : withHost(config.webhookUrl, config.apiBaseUrl)
  await sendJson('discord', url, { content: messageText(payload) })
}

export async function sendSlack(config: SlackConfig, payload: NotifyPayload): Promise<void> {
  const url =
    config.apiBaseUrl === undefined
      ? config.webhookUrl
      : withHost(config.webhookUrl, config.apiBaseUrl)
  await sendJson('slack', url, { text: messageText(payload) })
}

/** Mail options used by {@link sendEmail}; exported for direct assertions. */
export function buildEmailMessage(
  config: EmailConfig,
  payload: NotifyPayload,
): { from: string; to: string; subject: string; text: string } {
  return { from: config.from, to: config.to, subject: payload.title, text: payload.body }
}

export async function sendEmail(config: EmailConfig, payload: NotifyPayload): Promise<void> {
  const transporter =
    config.transport === 'json'
      ? createTransport({ jsonTransport: true })
      : createTransport({
          host: config.smtpHost,
          port: config.smtpPort,
          secure: config.secure,
          ...(config.username === undefined
            ? {}
            : { auth: { user: config.username, pass: config.password ?? '' } }),
        })
  await transporter.sendMail(buildEmailMessage(config, payload))
}

export async function sendNtfy(config: NtfyConfig, payload: NotifyPayload): Promise<void> {
  const url = `${config.server.replace(/\/+$/, '')}/${encodeURIComponent(config.topic)}`
  await sendJson(
    'ntfy',
    url,
    { topic: config.topic, title: payload.title, body: payload.body },
    config.token === undefined ? {} : { headers: { authorization: `Bearer ${config.token}` } },
  )
}

export async function sendGotify(config: GotifyConfig, payload: NotifyPayload): Promise<void> {
  const base =
    config.apiBaseUrl === undefined ? config.server : withHost(config.server, config.apiBaseUrl)
  await sendJson(
    'gotify',
    `${base.replace(/\/+$/, '')}/message?token=${encodeURIComponent(config.token)}`,
    {
      title: payload.title,
      message: payload.body,
      priority: config.priority,
    },
  )
}

export async function sendWebhook(config: WebhookConfig, payload: NotifyPayload): Promise<void> {
  let body: unknown
  if (config.template === undefined) {
    body = {
      title: payload.title,
      body: payload.body,
      monitor: payload.monitorName,
      status: payload.status,
      latencyMs: payload.latencyMs,
      downtimeMs: payload.downtimeMs,
      tags: payload.tags,
    }
  } else {
    const rendered = renderTemplate(config.template, payload)
    try {
      body = JSON.parse(rendered)
    } catch {
      throw new Error(`webhook template rendered invalid JSON: ${rendered.slice(0, 200)}`)
    }
  }
  await sendJson('webhook', config.url, body, { method: config.method, headers: config.headers })
}

/** Validate a raw channel config and deliver `payload` through its provider. */
export async function sendToChannel(
  type: ChannelType,
  config: unknown,
  payload: NotifyPayload,
): Promise<void> {
  switch (type) {
    case 'telegram':
      return sendTelegram(parseChannelConfig('telegram', config), payload)
    case 'discord':
      return sendDiscord(parseChannelConfig('discord', config), payload)
    case 'slack':
      return sendSlack(parseChannelConfig('slack', config), payload)
    case 'email':
      return sendEmail(parseChannelConfig('email', config), payload)
    case 'ntfy':
      return sendNtfy(parseChannelConfig('ntfy', config), payload)
    case 'gotify':
      return sendGotify(parseChannelConfig('gotify', config), payload)
    case 'webhook':
      return sendWebhook(parseChannelConfig('webhook', config), payload)
    default:
      throw new Error(`unsupported channel type: ${String(type)}`)
  }
}
