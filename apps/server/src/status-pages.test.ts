import { describe, expect, it } from 'vitest'
import { Database, SecretBox } from '@uptime/db'
import { MaintenanceEngine } from './maintenance.js'
import type { StatusPageStructure } from '@uptime/core'
import {
  autoPublishIncident,
  autoResolveIncidents,
  buildAtomFeed,
  buildBadgeSvg,
  buildRssFeed,
  buildStatusPagePayload,
  componentForMonitor,
  dispatchStatusEvent,
  injectOgMeta,
  incidentView,
} from './status-pages.js'

const KEY = 'b'.repeat(64)

function makeDb() {
  return Database.open({ file: ':memory:' })
}

function makeMaintenance(db: Database) {
  return new MaintenanceEngine({ db, tagIdsOf: (id) => db.listMonitorTagIds(id) })
}

function httpMonitor(db: Database, name: string) {
  return db.createMonitor({ type: 'http', name, intervalS: 60, retries: 1, retryIntervalS: 60, config: {} })
}

const STRUCTURE: StatusPageStructure = {
  groups: [{ name: 'Core', components: [{ id: 'api', label: 'API', monitorIds: [1] }] }],
  autoPublish: true,
}

function pageWithStructure(db: Database, structure: StatusPageStructure, monitorIds: number[], extra: Record<string, unknown> = {}) {
  return db.createStatusPage({
    slug: 'main',
    title: 'Acme Status',
    published: true,
    monitorIds,
    structure: JSON.stringify(structure),
    ...extra,
  })
}

describe('componentForMonitor', () => {
  it('finds the owning component and returns null otherwise', () => {
    const structure: StatusPageStructure = {
      groups: [
        { name: 'A', components: [{ id: 'x', label: 'X', monitorIds: [1, 2] }] },
        { name: 'B', components: [{ id: 'y', label: 'Y', monitorIds: [3] }] },
      ],
    }
    expect(componentForMonitor(structure, 2)?.id).toBe('x')
    expect(componentForMonitor(structure, 3)?.id).toBe('y')
    expect(componentForMonitor(structure, 9)).toBeNull()
  })
})

describe('buildStatusPagePayload', () => {
  it('assembles severity, monitors, uptime, daily bars and maintenance', () => {
    const db = makeDb()
    const m1 = httpMonitor(db, 'API worker')
    const m2 = httpMonitor(db, 'SQS consumer')
    db.insertHeartbeat({ monitorId: m1.id, status: 'up', latencyMs: 40 })
    db.insertHeartbeat({ monitorId: m2.id, status: 'down', latencyMs: null })

    const structure: StatusPageStructure = {
      groups: [
        {
          name: 'Backend',
          components: [
            { id: 'unit', label: 'Dispatch unit', monitorIds: [m1.id, m2.id], showChart: true },
            { id: 'web', label: 'Website', monitorIds: [m1.id] },
          ],
        },
      ],
      degradedLatencyMs: 30,
    }
    const page = pageWithStructure(db, structure, [m1.id, m2.id])
    const payload = buildStatusPagePayload(db, page, makeMaintenance(db), new Date('2026-01-10T12:00:00Z'))

    expect(payload.overall).toBe('partial_outage') // one of two monitors down
    const [group] = payload.groups
    expect(group?.name).toBe('Backend')
    const unit = group?.components[0]
    expect(unit?.status).toBe('partial_outage')
    expect(unit?.monitors.map((x) => x.status)).toEqual(['up', 'down'])
    expect(unit?.series).toBeDefined() // showChart true → series emitted
    const web = group?.components[1]
    expect(web?.status).toBe('degraded') // 40 ms > page threshold 30 ms, availability fine
    expect(web?.series).toBeUndefined()
    expect(payload.passwordRequired).toBe(false)
    expect(payload.incidents).toEqual([])
    db.close()
  })

  it('reports maintenance windows scoped to page monitors', () => {
    const db = makeDb()
    const m = httpMonitor(db, 'node')
    db.insertHeartbeat({ monitorId: m.id, status: 'up', latencyMs: 5 })
    const page = pageWithStructure(db, STRUCTURE, [m.id])
    db.createMaintenanceWindow({
      name: 'patch window',
      scope: 'ids',
      monitorIds: [m.id],
      strategy: 'single',
      startAt: new Date('2026-01-10T11:00:00Z'),
      endAt: new Date('2026-01-10T13:00:00Z'),
    })
    const payload = buildStatusPagePayload(db, page, makeMaintenance(db), new Date('2026-01-10T12:00:00Z'))
    expect(payload.maintenance.active.map((w) => w.name)).toEqual(['patch window'])
    db.close()
  })
})

describe('dispatchStatusEvent', () => {
  function setup() {
    const db = makeDb()
    const secrets = new SecretBox(KEY)
    const sent: { channelId: number; title: string }[] = []
    const notifier = {
      sendTo: async (channel: { id: number }, payload: { title: string }) => {
        sent.push({ channelId: channel.id, title: payload.title })
      },
    }
    const page = db.createStatusPage({ slug: 'p', title: 'Page', published: true, monitorIds: [], structure: '{}' })
    const channel = db.createChannel({ type: 'webhook', name: 'hook', configEnc: secrets.encryptJson({ url: 'https://x' }) })
    return { db, secrets, notifier, page, channel, sent }
  }

  it('respects event and component filters', async () => {
    const { db, secrets, notifier, page, channel, sent } = setup()
    const all = db.createStatusSubscription({ pageId: page.id, channelId: channel.id, componentIds: [], events: ['incident_open'] })
    expect(all.id).toBeGreaterThan(0)

    await dispatchStatusEvent({ db, secrets, notifier }, page, 'incident_open', {
      title: 'open!',
      body: 'b',
      componentIds: ['api'],
      status: 'down',
    })
    expect(sent.map((s) => s.title)).toEqual(['open!'])

    // Wrong event for the subscription → no delivery.
    await dispatchStatusEvent({ db, secrets, notifier }, page, 'incident_resolved', {
      title: 'resolved!',
      body: 'b',
      componentIds: ['api'],
      status: 'up',
    })
    expect(sent).toHaveLength(1)
    db.close()
  })

  it('skips when the component filter does not intersect', async () => {
    const { db, secrets, notifier, page, channel, sent } = setup()
    db.createStatusSubscription({ pageId: page.id, channelId: channel.id, componentIds: ['web'], events: ['incident_open'] })
    await dispatchStatusEvent({ db, secrets, notifier }, page, 'incident_open', {
      title: 'x',
      body: 'b',
      componentIds: ['api'],
      status: 'down',
    })
    expect(sent).toHaveLength(0)
    db.close()
  })
})

describe('auto publish', () => {
  it('creates then updates an auto incident and resolves on recovery', async () => {
    const db = makeDb()
    const m = httpMonitor(db, 'API')
    const page = pageWithStructure(db, STRUCTURE, [m.id])
    const events: string[] = []
    const deps = {
      db,
      dispatch: async (_page: unknown, event: string) => {
        events.push(event)
      },
    }

    expect(await autoPublishIncident(deps, m.id, { title: 'API is DOWN', body: 'boom' })).toBe(1)
    const open = db.getOpenStatusIncidentForMonitor(page.id, m.id)
    expect(open?.source).toBe('auto')
    expect(events).toEqual(['incident_open'])

    await autoPublishIncident(deps, m.id, { title: 'still down', body: 'still' })
    expect(events).toEqual(['incident_open', 'incident_update'])
    expect(db.listStatusIncidents({ pageId: page.id, active: true })).toHaveLength(1)

    expect(await autoResolveIncidents(deps, m.id, 'recovered')).toBe(1)
    expect(events).toEqual(['incident_open', 'incident_update', 'incident_resolved'])
    expect(db.listStatusIncidents({ pageId: page.id, active: true })).toHaveLength(0)
    expect(db.listStatusIncidents({ pageId: page.id })).toHaveLength(1)
    db.close()
  })

  it('skips unpublished pages, autoPublish:false and monitors outside components', async () => {
    const db = makeDb()
    const m = httpMonitor(db, 'API')
    const other = httpMonitor(db, 'Other')
    pageWithStructure(db, { ...STRUCTURE, autoPublish: false }, [m.id])
    db.createStatusPage({ slug: 'draft', title: 'Draft', published: false, monitorIds: [m.id], structure: JSON.stringify(STRUCTURE) })
    const deps = { db, dispatch: async () => {} }
    expect(await autoPublishIncident(deps, m.id, { title: 'x', body: 'y' })).toBe(0)
    expect(await autoPublishIncident(deps, other.id, { title: 'x', body: 'y' })).toBe(0)
    db.close()
  })
})

describe('feeds and badge', () => {
  it('renders RSS/Atom with escaped content', () => {
    const db = makeDb()
    const page = db.createStatusPage({ slug: 'p', title: 'Acme & Co', published: true, monitorIds: [], structure: '{}' })
    const incident = db.createStatusIncident({ pageId: page.id, title: 'API <down>', componentIds: ['api'], source: 'manual' })
    const view = incidentView(incident, db.getStatusIncident(incident.id)?.updates ?? [])

    const rss = buildRssFeed(page, [view], 'https://status.example.com')
    expect(rss).toContain('Acme &amp; Co')
    expect(rss).toContain('API &lt;down&gt;')
    const atom = buildAtomFeed(page, [view], 'https://status.example.com')
    expect(atom).toContain('<feed xmlns="http://www.w3.org/2005/Atom">')
    expect(atom).toContain('API &lt;down&gt;')
    db.close()
  })

  it('renders a colored badge per status', () => {
    expect(buildBadgeSvg('Acme', 'operational')).toContain('#22c55e')
    expect(buildBadgeSvg('Acme', 'major_outage')).toContain('#ef4444')
    expect(buildBadgeSvg('A<&>', 'unknown')).toContain('A&lt;&amp;&gt;')
  })

  it('injects OG meta and feed autodiscovery before </head>', () => {
    const out = injectOgMeta('<html><head><title>x</title></head><body></body></html>', {
      title: 'T',
      description: 'D',
      url: 'https://x/status/p',
      origin: 'https://x',
      slug: 'p',
    })
    expect(out).toContain('og:title" content="T"')
    expect(out.indexOf('og:title')).toBeLessThan(out.indexOf('</head>'))
    expect(out).toContain('rel="alternate" type="application/rss+xml"')
    expect(out).toContain('href="https://x/status/p/rss.xml"')
    expect(out).toContain('href="https://x/status/p/atom.xml"')
    expect(out.indexOf('rss+xml')).toBeLessThan(out.indexOf('</head>'))
  })
})
