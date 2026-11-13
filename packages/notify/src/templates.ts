import type { NotifyPayload } from './types.js'

/**
 * Shared BlasterSystems email frame (UP-26/UP-27). Follows the design kit's
 * email rules (`guidelines/brand-email.html`): tables and inline hex only —
 * mail clients ignore CSS variables, flex and web fonts — with Fira Sans
 * falling back to Helvetica/Arial and DM Mono to Menlo/Consolas. Vermilion
 * (the thread) appears exactly once per email: the 2px status line on alarm
 * (down) states.
 *
 * Hex values are the light-step palette from the kit's colour tokens
 * (identity v0.2); the frame is fixed light like the kit's email signatures.
 */
const PAPER = '#f1f4f6'
const CARD = '#fbfcfd'
const SUNKEN = '#e7eaed'
const INK = '#161b22'
const INK_2 = '#43484f'
const INK_3 = '#62676d'
const RULE = '#d2d4d8'
const THREAD = '#da452c'
const SANS = "'Fira Sans',Helvetica,Arial,sans-serif"
const MONO = "'DM Mono',Menlo,Consolas,monospace"
const MARK_URL = 'https://blastersystems.com/brand/mark-ink.png'
const PRODUCT = 'uptime'
const ENDORSE = 'A BlasterSystems product'

export interface EmailRow {
  label: string
  value: string
}

export interface EmailAction {
  label: string
  url: string
  /** Raw URL repeated as text for clients that strip buttons. */
  fallbackUrl?: string
  note?: string
}

export interface EmailFrameInput {
  eyebrow: string
  heading: string
  /** Plain paragraph in the body font (prose, e.g. an admin status update). */
  body?: string
  /** Preformatted data block in DM Mono (e.g. an error snippet). */
  detail?: string
  rows?: EmailRow[]
  /** Mono label row; `chipsLabel` names it in HTML and text ("Tags", "Event", …). */
  chips?: string[]
  chipsLabel?: string
  action?: EmailAction
  /** Hidden preview text; defaults to the heading. */
  preheader?: string
  /** 'down' renders the vermilion alarm line and the ◆ glyph. */
  accent?: 'down' | 'up'
}

/** Status-page subscription events (`apps/server/src/status-pages.ts`). */
const EVENT_LABELS: Record<string, string> = {
  incident_open: 'incident opened',
  incident_update: 'incident update',
  incident_resolved: 'incident resolved',
  maintenance_start: 'maintenance started',
  maintenance_end: 'maintenance ended',
}

/** Escape a value interpolated into HTML text or an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Compact duration ("1h 12m 4s"); shared with the incident body strings. */
export function humanDuration(ms: number): string {
  const totalS = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(totalS / 3600)
  const m = Math.floor((totalS % 3600) / 60)
  const s = totalS % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function statusLine(accent: 'down' | 'up'): string {
  const color = accent === 'down' ? THREAD : INK
  return `<tr><td style="height:2px;background-color:${color};font-size:0;line-height:0;">&nbsp;</td></tr>`
}

function eyebrowRow(eyebrow: string, accent: 'down' | 'up'): string {
  const glyph = accent === 'down' ? '◆' : '■'
  return `<tr><td style="padding:20px 24px 0;font-family:${MONO};font-size:10px;letter-spacing:1px;text-transform:uppercase;color:${INK_3};"><span style="color:${INK};">${glyph}</span>&nbsp;&nbsp;${escapeHtml(eyebrow)}</td></tr>`
}

function headingRow(heading: string): string {
  return `<tr><td style="padding:8px 24px 0;font-family:${SANS};font-size:22px;font-weight:600;line-height:1.2;color:${INK};">${escapeHtml(heading)}</td></tr>`
}

function bodyRow(body: string): string {
  return `<tr><td style="padding:10px 24px 0;font-family:${SANS};font-size:16px;line-height:1.5;color:${INK};">${escapeHtml(body)}</td></tr>`
}

function detailRow(detail: string): string {
  return `<tr><td style="padding:14px 24px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${SUNKEN};border-radius:4px;">
    <tr><td style="padding:12px 14px;font-family:${MONO};font-size:13px;line-height:1.5;color:${INK_2};white-space:pre-wrap;word-break:break-word;">${escapeHtml(detail)}</td></tr>
  </table>
</td></tr>`
}

function rowsBlock(rows: EmailRow[]): string {
  const trs = rows
    .map(
      (r) => `<tr>
        <td style="padding:8px 0;border-top:1px solid ${RULE};font-family:${MONO};font-size:10px;letter-spacing:1px;text-transform:uppercase;color:${INK_3};">${escapeHtml(r.label)}</td>
        <td align="right" style="padding:8px 0;border-top:1px solid ${RULE};font-family:${MONO};font-size:13px;color:${INK};">${escapeHtml(r.value)}</td>
      </tr>`,
    )
    .join('\n')
  return `<tr><td style="padding:16px 24px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
    ${trs}
  </table>
</td></tr>`
}

function chipsRow(label: string, chips: string[]): string {
  return `<tr><td style="padding:12px 24px 0;font-family:${MONO};font-size:10px;letter-spacing:1px;text-transform:uppercase;color:${INK_3};">${escapeHtml(label)}&nbsp;&nbsp;${chips.map((c) => escapeHtml(c)).join('&nbsp;&nbsp;')}</td></tr>`
}

function actionBlock(action: EmailAction): string {
  const button = `<tr><td style="padding:16px 24px 0;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
    <tr><td bgcolor="${INK}" style="background-color:${INK};border-radius:2px;">
      <a href="${escapeHtml(action.url)}" target="_blank" style="display:inline-block;padding:12px 20px;font-family:${SANS};font-size:14px;font-weight:500;color:${PAPER};text-decoration:none;">${escapeHtml(action.label)}</a>
    </td></tr>
  </table>
</td></tr>`
  const fallback = action.fallbackUrl === undefined ? '' : `<tr><td style="padding:12px 24px 0;font-family:${MONO};font-size:12px;line-height:1.5;color:${INK_3};word-break:break-all;">${escapeHtml(action.fallbackUrl)}</td></tr>`
  const note = action.note === undefined ? '' : `<tr><td style="padding:12px 24px 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${INK_2};">${escapeHtml(action.note)}</td></tr>`
  return `${button}\n${fallback}\n${note}`
}

function footerRow(): string {
  return `<tr><td style="padding:20px 24px;border-top:1px solid ${RULE};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td style="vertical-align:middle;padding-right:10px;"><img src="${MARK_URL}" width="24" height="8" alt="" style="display:block;border:0;width:24px;height:8px;"></td>
      <td style="vertical-align:middle;font-family:${SANS};font-size:15px;font-weight:600;color:${INK};">${PRODUCT}</td>
    </tr>
    <tr><td colspan="2" style="padding-top:4px;"><span style="font-family:${MONO};font-size:10px;letter-spacing:1px;text-transform:uppercase;color:${INK_3};">${ENDORSE}</span></td></tr>
  </table>
</td></tr>`
}

function frameText(input: EmailFrameInput): string {
  const parts: string[] = [input.heading]
  if (input.body !== undefined) parts.push('', input.body)
  if (input.detail !== undefined) parts.push('', input.detail)
  const rows = input.rows ?? []
  if (rows.length > 0) {
    const width = Math.max(...rows.map((r) => r.label.length))
    parts.push('', ...rows.map((r) => `${r.label}:${' '.repeat(width - r.label.length + 1)}${r.value}`))
  }
  const chips = input.chips ?? []
  if (chips.length > 0) parts.push('', `${input.chipsLabel ?? 'Tags'}: ${chips.join(', ')}`)
  if (input.action !== undefined) {
    parts.push('', `${input.action.label}:`, input.action.url)
    if (input.action.note !== undefined) parts.push('', input.action.note)
  }
  return parts.join('\n')
}

/** Render the shared frame to a full HTML email plus its plain-text alternative. */
export function renderEmailFrame(input: EmailFrameInput): { html: string; text: string } {
  const accent = input.accent ?? 'up'
  const blocks: string[] = [
    statusLine(accent),
    eyebrowRow(input.eyebrow, accent),
    headingRow(input.heading),
  ]
  if (input.detail !== undefined) blocks.push(detailRow(input.detail))
  if (input.body !== undefined) blocks.push(bodyRow(input.body))
  if (input.rows !== undefined && input.rows.length > 0) blocks.push(rowsBlock(input.rows))
  if (input.chips !== undefined && input.chips.length > 0) {
    blocks.push(chipsRow(input.chipsLabel ?? 'Tags', input.chips))
  }
  if (input.action !== undefined) blocks.push(actionBlock(input.action))
  blocks.push(footerRow())
  const preheader = input.preheader ?? input.heading
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.heading)}</title></head>
<body style="margin:0;padding:0;background-color:${PAPER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAPER}" style="width:100%;background-color:${PAPER};">
  <tr><td align="center" style="padding:24px 20px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:${CARD};border:1px solid ${RULE};border-radius:4px;font-family:${SANS};">
    ${blocks.join('\n    ')}
  </table>
  </td></tr>
</table>
</body></html>`
  return { html, text: frameText(input) }
}

/**
 * Map a notification payload onto the shared frame. Monitor alerts render
 * their body (error data) in the mono detail block while down, and as prose
 * when recovered; status-page subscription bodies are always prose with the
 * event named in the chips row.
 */
export function renderNotifyEmail(payload: NotifyPayload): { html: string; text: string } {
  const isStatusPage = payload.tags.includes('status-page')
  const event = isStatusPage ? payload.tags.find((tag) => tag !== 'status-page') : undefined
  // Maintenance dispatches ride status 'down' (the component is degraded), but
  // planned maintenance is not an alarm: keep the ink line for it.
  const maintenance = event !== undefined && event.startsWith('maintenance_')
  const accent = payload.status === 'down' && !maintenance ? 'down' : 'up'
  const rows: EmailRow[] = []
  if (payload.latencyMs !== null && payload.latencyMs > 0) {
    rows.push({ label: 'Latency', value: `${payload.latencyMs} ms` })
  }
  if (payload.downtimeMs !== null) {
    rows.push({ label: 'Downtime', value: humanDuration(payload.downtimeMs) })
  }
  if (!isStatusPage && payload.failures !== undefined) {
    rows.push({ label: 'Consecutive failures', value: String(payload.failures) })
  }
  const chips = isStatusPage ? (event === undefined ? [] : [EVENT_LABELS[event] ?? event]) : payload.tags
  return renderEmailFrame({
    eyebrow: isStatusPage
      ? 'Status page'
      : payload.status === 'down' && payload.downtimeMs !== null
        ? 'Uptime monitor · repeat'
        : 'Uptime monitor',
    heading: payload.title,
    accent,
    body: isStatusPage || payload.status === 'up' ? payload.body : undefined,
    detail: !isStatusPage && payload.status === 'down' ? payload.body : undefined,
    rows,
    chips,
    chipsLabel: isStatusPage ? 'Event' : 'Tags',
    preheader: `${payload.title} — ${payload.body}`.slice(0, 140),
  })
}
