import { sendToChannel } from './providers.js'
import type { ChannelType, NotifyPayload } from './types.js'

export { CHANNEL_TYPES } from './types.js'
export type { ChannelType, NotifyPayload } from './types.js'
export { channelConfigSchemas, parseChannelConfig } from './config.js'
export type {
  ChannelConfig,
  ChannelConfigMap,
  DiscordConfig,
  EmailConfig,
  GotifyConfig,
  NtfyConfig,
  SlackConfig,
  TelegramConfig,
  WebhookConfig,
} from './config.js'
export { renderTemplate } from './template.js'
export { sendToChannel } from './providers.js'

/** Channel row as the notifier sees it; `config` is the already-decrypted config. */
export interface ChannelLike {
  id: number
  type: ChannelType
  name: string
  config: unknown
  active: boolean
}

/** Delivery function — injectable so routing can be tested without HTTP. */
export type SendFn = (type: ChannelType, config: unknown, payload: NotifyPayload) => Promise<void>

/** Default delivery path: validate the config, then dispatch to its provider. */
export const defaultSend: SendFn = sendToChannel

/** A channel that could not be notified; `notifyMonitor` never throws. */
export interface NotifyFailure {
  channelId: string
  error: string
}

export interface NotifierOptions {
  /** All channels known to the instance. */
  channels: () => ChannelLike[]
  /** Channel ids routed for `monitorId`; an empty list means "use the defaults". */
  monitorChannelIds: (monitorId: number) => number[]
  /** Instance-wide default channel ids. */
  defaultChannelIds: () => number[]
  send?: SendFn
}

export class Notifier {
  private readonly options: NotifierOptions
  private readonly send: SendFn

  constructor(options: NotifierOptions) {
    this.options = options
    this.send = options.send ?? defaultSend
  }

  /**
   * Deliver `payload` for `monitorId` to its routed channels — or to the
   * instance defaults when it has none — skipping inactive channels. Sends run
   * concurrently and failures are isolated: the returned list holds one entry
   * per failed channel instead of throwing.
   */
  async notifyMonitor(monitorId: number, payload: NotifyPayload): Promise<NotifyFailure[]> {
    const routed = this.options.monitorChannelIds(monitorId)
    const ids = routed.length > 0 ? routed : this.options.defaultChannelIds()
    if (ids.length === 0) return []
    const active = new Map(
      this.options
        .channels()
        .filter((c) => c.active)
        .map((c) => [c.id, c]),
    )
    const targets = [...new Set(ids)].flatMap((id) => {
      const channel = active.get(id)
      return channel === undefined ? [] : [channel]
    })
    const failures = await Promise.all(
      targets.map(async (channel): Promise<NotifyFailure | null> => {
        try {
          await this.send(channel.type, channel.config, payload)
          return null
        } catch (error) {
          return {
            channelId: String(channel.id),
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )
    return failures.filter((failure): failure is NotifyFailure => failure !== null)
  }

  /** Send a test payload through `channel` (active or not). Throws on failure. */
  async testChannel(channel: ChannelLike): Promise<void> {
    await this.send(channel.type, channel.config, {
      title: 'Test notification',
      body: `Test notification from channel "${channel.name}"`,
      monitorName: 'Test',
      status: 'up',
      latencyMs: null,
      downtimeMs: null,
      tags: [],
    })
  }
}
