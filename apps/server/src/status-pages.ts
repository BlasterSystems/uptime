import type {
  Database,
  MaintenanceWindowRow,
  StatusIncidentRow,
  StatusIncidentUpdateRow,
  StatusPageRow,
} from '@uptime/db'
import type { SecretBox } from '@uptime/db'
import {
  componentStatus,
  overallStatus,
  parseStatusPageStructure,
  type ComponentMonitorState,
  type ComponentStatus,
  type OverallStatus,
  type StatusPageComponent,
  type StatusPageStructure,
} from '@uptime/core'
import type { ChannelType, NotifyPayload } from '@uptime/notify'
import type { MaintenanceEngine } from './maintenance.js'

/** Subscription event names (stored on status_subscriptions.events). */
export const STATUS_EVENTS = [
  'incident_open',
  'incident_update',
  'incident_resolved',
  'maintenance_start',
  'maintenance_end',
] as const
export type StatusEvent = (typeof STATUS_EVENTS)[number]

export interface StatusPageMonitorView {
  id: number
  name: string
  type: string
  status: string
  latencyMs: number | null
  lastBeatAt: string | null
}

export interface StatusPageDailyUptime {
  date: string
  uptimePct: number
  total: number
  down: number
  maintenance: number
}

export interface StatusPageComponentView {
  id: string
  label: string
  description: string | null
  status: ComponentStatus
  showUptime: boolean
  showChart: boolean
  monitors: StatusPageMonitorView[]
  uptimePct: number
  daily: StatusPageDailyUptime[]
  /** 24h response series; present only when showChart is true. `latencyMs: null` = down beat. */
  series?: { t: string; latencyMs: number | null }[]
}

export interface StatusPageIncidentView {
  id: number
  title: string
  status: StatusIncidentRow['status']
  impact: StatusIncidentRow['impact']
  componentIds: string[]
  source: StatusIncidentRow['source']
  createdAt: string
  resolvedAt: string | null
  updates: { id: number; status: string; body: string; createdAt: string }[]
}

export interface StatusPagePayload {
  slug: string
  title: string
  logo: string | null
  theme: Record<string, unknown> | null
  footerText: string | null
  overall: OverallStatus
  degradedLatencyMs: number | null
  groups: { name: string; components: StatusPageComponentView[] }[]
  incidents: StatusPageIncidentView[]
  maintenance: {
    active: { id: number; name: string; startAt: string | null; endAt: string | null }[]
    upcoming: { id: number; name: string; startAt: string | null; endAt: string | null }[]
  }
  passwordRequired: boolean
}

export function incidentView(
  incident: StatusIncidentRow,
  updates: StatusIncidentUpdateRow[],
): StatusPageIncidentView {
  return {
    id: incident.id,
    title: incident.title,
    status: incident.status,
    impact: incident.impact,
    componentIds: incident.componentIds,
    source: incident.source,
    createdAt: incident.createdAt.toISOString(),
    resolvedAt: incident.resolvedAt === null ? null : incident.resolvedAt.toISOString(),
    updates: updates.map((u) => ({
      id: u.id,
      status: u.status,
      body: u.body,
      createdAt: u.createdAt.toISOString(),
    })),
  }
}

/** Finds the component that owns `monitorId` in a parsed structure. */
export function componentForMonitor(
  structure: StatusPageStructure,
  monitorId: number,
): StatusPageComponent | null {
  for (const group of structure.groups) {
    for (const component of group.components) {
      if (component.monitorIds.includes(monitorId)) return component
    }
  }
  return null
}

function mergeDaily(
  perMonitor: StatusPageDailyUptime[][],
): StatusPageDailyUptime[] {
  const byDate = new Map<string, { up: number; down: number; total: number; maintenance: number }>()
  for (const list of perMonitor) {
    for (const day of list) {
      const agg = byDate.get(day.date) ?? { up: 0, down: 0, total: 0, maintenance: 0 }
      const decisive = day.total - day.maintenance
      agg.up += Math.round((day.uptimePct / 100) * Math.max(decisive, 0))
      agg.down += day.down
      agg.total += day.total
      agg.maintenance += day.maintenance
      byDate.set(day.date, agg)
    }
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, agg]) => {
      const decisive = agg.up + agg.down
      return {
        date,
        uptimePct: decisive === 0 ? 100 : (agg.up / decisive) * 100,
        total: agg.total,
        down: agg.down,
        maintenance: agg.maintenance,
      }
    })
}

function uptime24h(db: Database, monitorIds: number[], now: Date): number {
  let up = 0
  let decisive = 0
  const since = new Date(now.getTime() - 24 * 3600_000)
  for (const id of monitorIds) {
    for (const beat of db.listHeartbeatsSince(id, since, 5000)) {
      if (beat.status === 'up') {
        up += 1
        decisive += 1
      } else if (beat.status === 'down') {
        decisive += 1
      }
    }
  }
  return decisive === 0 ? 100 : (up / decisive) * 100
}

/** Assembles the public payload (severity, components, incidents, maintenance). */
export function buildStatusPagePayload(
  db: Database,
  page: StatusPageRow,
  maintenance: MaintenanceEngine,
  now: Date = new Date(),
): StatusPagePayload {
  const structure = parseStatusPageStructure(page.structure)
  const pageMonitorIds = structure.groups.flatMap((g) => g.components.flatMap((c) => c.monitorIds))
  const statuses: ComponentStatus[] = []

  const groups = structure.groups.map((group) => ({
    name: group.name,
    components: group.components.map((component): StatusPageComponentView => {
      const states: ComponentMonitorState[] = []
      const monitors: StatusPageMonitorView[] = []
      for (const monitorId of component.monitorIds) {
        const row = db.getMonitor(monitorId)
        if (!row) continue
        const [latest] = db.listHeartbeats(monitorId, { limit: 1 })
        const state = latest?.status ?? 'pending'
        states.push({
          monitorId,
          status: state,
          latencyMs: latest?.latencyMs ?? null,
          inMaintenance: maintenance.isUnder(monitorId, now),
        })
        monitors.push({
          id: row.id,
          name: row.name,
          type: row.type,
          status: state,
          latencyMs: latest?.latencyMs ?? null,
          lastBeatAt: latest ? latest.time.toISOString() : null,
        })
      }
      const status = componentStatus(component, states, structure.degradedLatencyMs)
      statuses.push(status)
      const daily = mergeDaily(component.monitorIds.map((id) => db.getDailyUptime(id, 90)))
      let series: { t: string; latencyMs: number | null }[] | undefined
      if (component.showChart === true) {
        const since = new Date(now.getTime() - 24 * 3600_000)
        series = component.monitorIds
          .flatMap((id) =>
            db.listHeartbeatsSince(id, since, 1000).map((beat) => ({
              t: beat.time.toISOString(),
              latencyMs: beat.status === 'up' ? beat.latencyMs : null,
            })),
          )
          .sort((a, b) => (a.t < b.t ? -1 : 1))
          .slice(-1000)
      }
      return {
        id: component.id,
        label: component.label,
        description: component.description ?? null,
        status,
        showUptime: component.showUptime ?? true,
        showChart: component.showChart ?? false,
        monitors,
        uptimePct: uptime24h(db, component.monitorIds, now),
        daily,
        ...(series === undefined ? {} : { series }),
      }
    }),
  }))

  const incidents = db
    .listStatusIncidents({ pageId: page.id, active: true })
    .map((incident) => incidentView(incident, db.getStatusIncident(incident.id)?.updates ?? []))

  const listing = maintenance.listFor(pageMonitorIds, now)

  return {
    slug: page.slug,
    title: page.title,
    logo: page.logo,
    theme: page.theme,
    footerText: page.footerText,
    overall: overallStatus(statuses),
    degradedLatencyMs: structure.degradedLatencyMs ?? null,
    groups,
    incidents,
    maintenance: {
      active: listing.active.map(maintenanceView),
      upcoming: listing.upcoming.map(maintenanceView),
    },
    passwordRequired: page.hasPassword,
  }
}

export function maintenanceView(w: MaintenanceWindowRow): {
  id: number
  name: string
  startAt: string | null
  endAt: string | null
} {
  return {
    id: w.id,
    name: w.name,
    startAt: w.startAt === null ? null : w.startAt.toISOString(),
    endAt: w.endAt === null ? null: w.endAt.toISOString(),
  }
}

// ---- Subscription dispatch ----

export interface StatusDispatchDeps {
  db: Database
  secrets: SecretBox
  notifier: { sendTo: (channel: { id: number; type: ChannelType; name: string; config: unknown; active: boolean }, payload: NotifyPayload) => Promise<void> }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Fans a status event out to the page's subscriptions (channel-based; empty
 * component filter = whole page). Failures are logged, never thrown.
 */
export async function dispatchStatusEvent(
  deps: StatusDispatchDeps,
  page: StatusPageRow,
  event: StatusEvent,
  opts: { title: string; body: string; componentIds: string[]; status: 'up' | 'down' },
): Promise<void> {
  for (const sub of deps.db.listSubscriptionsForPage(page.id)) {
    if (!sub.events.includes(event)) continue
    if (sub.componentIds.length > 0 && !sub.componentIds.some((c) => opts.componentIds.includes(c))) continue
    const row = deps.db.getChannel(sub.channelId)
    if (!row || !row.active) continue
    try {
      const config = deps.secrets.decryptJson<Record<string, unknown>>(row.configEnc)
      await deps.notifier.sendTo(
        { id: row.id, type: row.type as ChannelType, name: row.name, config, active: row.active },
        {
          title: opts.title,
          body: opts.body,
          monitorName: page.title,
          status: opts.status,
          latencyMs: null,
          downtimeMs: null,
          tags: ['status-page', event],
        },
      )
    } catch (err) {
      console.warn(
        `status subscription ${sub.id} delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

// ---- Auto-publish (monitor incidents → public status incidents) ----

export interface AutoPublishDeps {
  db: Database
  dispatch: (page: StatusPageRow, event: StatusEvent, opts: { title: string; body: string; componentIds: string[]; status: 'up' | 'down' }) => Promise<void>
}

/** Opens (or updates) a public incident on every published page containing the monitor. */
export async function autoPublishIncident(
  deps: AutoPublishDeps,
  monitorId: number,
  info: { title: string; body: string },
): Promise<number> {
  let touched = 0
  for (const page of deps.db.listStatusPages()) {
    if (!page.published) continue
    const structure = parseStatusPageStructure(page.structure)
    if (structure.autoPublish === false) continue
    const component = componentForMonitor(structure, monitorId)
    if (!component) continue
    const existing = deps.db.getOpenStatusIncidentForMonitor(page.id, monitorId)
    if (existing) {
      deps.db.addStatusIncidentUpdate(existing.id, { status: 'monitoring', body: info.body })
      await deps.dispatch(page, 'incident_update', {
        title: `${component.label}: ongoing incident`,
        body: info.body,
        componentIds: [component.id],
        status: 'down',
      })
    } else {
      deps.db.createStatusIncident({
        pageId: page.id,
        title: `${component.label} unavailable`,
        componentIds: [component.id],
        source: 'auto',
        monitorId,
        impact: 'major',
      })
      await deps.dispatch(page, 'incident_open', {
        title: `${page.title}: ${component.label} unavailable`,
        body: info.body,
        componentIds: [component.id],
        status: 'down',
      })
    }
    touched += 1
  }
  return touched
}

/** Resolves the open auto incidents for a recovered monitor on every published page. */
export async function autoResolveIncidents(
  deps: AutoPublishDeps,
  monitorId: number,
  body: string,
): Promise<number> {
  let touched = 0
  for (const page of deps.db.listStatusPages()) {
    if (!page.published) continue
    const structure = parseStatusPageStructure(page.structure)
    const component = componentForMonitor(structure, monitorId)
    if (!component) continue
    const resolved = deps.db.resolveOpenStatusIncidentsForMonitor(page.id, monitorId, body)
    if (resolved > 0) {
      touched += 1
      await deps.dispatch(page, 'incident_resolved', {
        title: `${page.title}: ${component.label} recovered`,
        body,
        componentIds: [component.id],
        status: 'up',
      })
    }
  }
  return touched
}

// ---- Feeds & badge ----

export function buildRssFeed(page: StatusPageRow, incidents: StatusPageIncidentView[], origin: string): string {
  const items = incidents
    .map(
      (i) => `    <item>
      <title>${xmlEscape(i.title)}</title>
      <link>${origin}/status/${page.slug}</link>
      <guid>status-incident-${i.id}</guid>
      <pubDate>${new Date(i.createdAt).toUTCString()}</pubDate>
      <description>${xmlEscape(latestUpdateBody(i))}</description>
    </item>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlEscape(page.title)} — status incidents</title>
    <link>${origin}/status/${page.slug}</link>
    <description>Incident updates for ${xmlEscape(page.title)}</description>
${items}
  </channel>
</rss>
`
}

export function buildAtomFeed(page: StatusPageRow, incidents: StatusPageIncidentView[], origin: string): string {
  const entries = incidents
    .map(
      (i) => `  <entry>
    <title>${xmlEscape(i.title)}</title>
    <id>status-incident-${i.id}</id>
    <updated>${new Date(i.createdAt).toISOString()}</updated>
    <link href="${origin}/status/${page.slug}"/>
    <content type="text">${xmlEscape(latestUpdateBody(i))}</content>
  </entry>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${xmlEscape(page.title)} — status incidents</title>
  <id>${origin}/status/${page.slug}</id>
  <link href="${origin}/status/${page.slug}"/>
  <updated>${new Date().toISOString()}</updated>
${entries}
</feed>
`
}

function latestUpdateBody(incident: StatusPageIncidentView): string {
  const latest = incident.updates[incident.updates.length - 1]
  return latest ? latest.body : incident.title
}

const BADGE_COLORS: Record<OverallStatus, string> = {
  operational: '#22c55e',
  degraded: '#f59e0b',
  partial_outage: '#f97316',
  major_outage: '#ef4444',
  maintenance: '#64748b',
  unknown: '#94a3b8',
}

const BADGE_LABELS: Record<OverallStatus, string> = {
  operational: 'operational',
  degraded: 'degraded',
  partial_outage: 'partial outage',
  major_outage: 'major outage',
  maintenance: 'maintenance',
  unknown: 'unknown',
}

/** Shields-style SVG badge (overall or one component). */
export function buildBadgeSvg(label: string, status: OverallStatus): string {
  const right = BADGE_LABELS[status]
  const color = BADGE_COLORS[status]
  const leftWidth = 8 + label.length * 6.6
  const rightWidth = 8 + right.length * 6.6
  const width = Math.round(leftWidth + rightWidth)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${xmlEscape(label)}: ${right}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${Math.round(leftWidth)}" height="20" fill="#555"/>
    <rect x="${Math.round(leftWidth)}" width="${Math.round(rightWidth)}" height="20" fill="${color}"/>
    <rect width="${width}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${Math.round(leftWidth / 2)}" y="14">${xmlEscape(label)}</text>
    <text x="${Math.round(leftWidth + rightWidth / 2)}" y="14">${right}</text>
  </g>
</svg>
`
}

/** Minimal OpenGraph/Twitter meta + feed autodiscovery for the SPA shell. */
export function injectOgMeta(html: string, opts: { title: string; description: string; url: string; origin: string; slug: string }): string {
  const base = `${opts.origin}/status/${opts.slug}`
  const meta = `
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${xmlEscape(opts.title)}" />
    <meta property="og:description" content="${xmlEscape(opts.description)}" />
    <meta property="og:url" content="${xmlEscape(opts.url)}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${xmlEscape(opts.title)}" />
    <meta name="twitter:description" content="${xmlEscape(opts.description)}" />
    <link rel="alternate" type="application/rss+xml" title="${xmlEscape(opts.title)} — incidents (RSS)" href="${xmlEscape(`${base}/rss.xml`)}" />
    <link rel="alternate" type="application/atom+xml" title="${xmlEscape(opts.title)} — incidents (Atom)" href="${xmlEscape(`${base}/atom.xml`)}" />`
  return html.replace('</head>', `${meta}\n  </head>`)
}
