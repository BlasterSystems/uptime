import type { Database, SecretBox } from '@uptime/db'

/**
 * Outbound transactional email (SPEC §5): password-reset links and admin test
 * sends. Delivery goes through the Resend HTTP API; the API key lives encrypted
 * in `mailer_settings` (ADR-0002) and is configured in Settings → General.
 *
 * `RESEND_API_BASE_URL` overrides the API host — a test seam mirroring the
 * `apiBaseUrl` option on notification channel configs.
 */
const DEFAULT_RESEND_BASE = 'https://api.resend.com'

export interface MailInput {
  to: string
  subject: string
  text: string
  html?: string
}

/** Injectable mailer boundary; tests stub this instead of the network. */
export interface MailerLike {
  /** False until the enabled flag, an API key and a from-address are stored. */
  readonly configured: boolean
  sendMail(input: MailInput): Promise<void>
}

export function createMailer(deps: { db: Database; secrets: SecretBox; apiBaseUrl?: string }): MailerLike {
  const { db, secrets } = deps
  return {
    get configured(): boolean {
      const settings = db.getMailerSettings()
      return settings.enabled && settings.apiKeyEnc !== null && settings.fromAddress !== null
    },

    async sendMail(input: MailInput): Promise<void> {
      const settings = db.getMailerSettings()
      if (!settings.enabled || settings.apiKeyEnc === null || settings.fromAddress === null) {
        throw new Error('mailer is not configured')
      }
      const apiKey = secrets.decrypt(settings.apiKeyEnc)
      const base = (deps.apiBaseUrl ?? process.env.RESEND_API_BASE_URL ?? DEFAULT_RESEND_BASE).replace(
        /\/+$/,
        '',
      )
      const response = await fetch(`${base}/emails`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          from: settings.fromAddress,
          to: [input.to],
          subject: input.subject,
          text: input.text,
          ...(input.html === undefined ? {} : { html: input.html }),
        }),
      })
      const body = await response.text().catch(() => '')
      if (!response.ok) {
        throw new Error(`resend responded with ${response.status}: ${body.slice(0, 200)}`)
      }
    },
  }
}
