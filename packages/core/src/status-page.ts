import { z } from 'zod'
import type { HeartbeatStatus } from './types.js'

/**
 * Status-page severity model (docs/STATUS_PAGES_PLAN.md wave 1).
 *
 * A page is a tree of groups → components; a component aggregates one or more
 * monitors (`monitorIds`) into a single tracked unit — e.g. a fleet of async
 * workers where every process has a push monitor but the page shows one
 * component. Severity is always derived from live monitor state, never stored;
 * the persisted structure is a plain JSON tree validated by
 * {@link parseStatusPageStructure}.
 */
export type ComponentStatus =
  'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance' | 'unknown'

/** Severity shown for the page as a whole — the worst of its components. */
export type OverallStatus = ComponentStatus

/** One tracked unit of a status page, backed by one or more monitors. */
export interface StatusPageComponent {
  /** Stable slug (anchors, incident links): `/^[a-z0-9-]{1,60}$/`. */
  id: string
  /** Public name, 1..120 characters. */
  label: string
  /** Optional sentence rendered under the label. */
  description?: string
  /** Backing monitors; at least one. */
  monitorIds: number[]
  /**
   * How the backing monitors combine (default `'worst'`):
   * `'worst'` — a single down monitor marks the component affected;
   * `'any'` — the component stays up while any monitor is up.
   */
  aggregation?: 'worst' | 'any'
  /** Latency threshold in ms for `degraded`, overriding the page default. */
  degradedLatencyMs?: number
  /** Render the per-component uptime bars (default true). */
  showUptime?: boolean
  /** Render the per-component response-time chart (default false). */
  showChart?: boolean
}

/** A titled section of components on the page. */
export interface StatusPageGroup {
  name: string
  components: StatusPageComponent[]
}

/** The stored `status_pages.structure` tree. */
export interface StatusPageStructure {
  groups: StatusPageGroup[]
  /** Page-level latency threshold in ms for `degraded` (per-component override wins). */
  degradedLatencyMs?: number
  /** Auto-create public incidents from monitor incidents (default true). */
  autoPublish?: boolean
}

const componentSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/, 'id must match ^[a-z0-9-]{1,60}$'),
  label: z
    .string()
    .min(1, 'label must not be empty')
    .max(120, 'label must be at most 120 characters'),
  description: z.string().optional(),
  monitorIds: z.array(z.int().positive()).min(1, 'monitorIds must contain at least one monitor'),
  aggregation: z.enum(['worst', 'any']).default('worst'),
  degradedLatencyMs: z.int().positive().optional(),
  showUptime: z.boolean().default(true),
  showChart: z.boolean().default(false),
})

const groupSchema = z.object({
  name: z.string().min(1, 'group name must not be empty'),
  components: z.array(componentSchema),
})

/**
 * Zod schema for {@link StatusPageStructure}: defaults applied, unknown keys
 * stripped. `groups` defaults to `[]` because the `status_pages.structure`
 * column defaults to `'{}'` — a freshly created page has no components yet.
 */
export const statusPageStructureSchema = z.object({
  groups: z.array(groupSchema).default([]),
  degradedLatencyMs: z.int().positive().optional(),
  autoPublish: z.boolean().default(true),
})

/**
 * Validate a raw (stored or client-supplied) status-page structure, applying
 * the documented defaults: `groups: []`, `autoPublish: true`, and per
 * component `aggregation: 'worst'`, `showUptime: true`, `showChart: false`.
 * Throws a `ZodError` when `raw` is not a structure.
 */
export function parseStatusPageStructure(raw: unknown): StatusPageStructure {
  return statusPageStructureSchema.parse(raw)
}

/** Live state of one monitor backing a component. */
export interface ComponentMonitorState {
  monitorId: number
  status: HeartbeatStatus
  latencyMs: number | null
  /** Whether a maintenance window currently covers the monitor. */
  inMaintenance: boolean
}

/**
 * Severity of one component given the live state of its monitors.
 *
 * Rules, in order:
 * 1. no states (e.g. every backing monitor was deleted) → `unknown`.
 * 2. every state in maintenance → `maintenance`; maintenance monitors are
 *    treated as up for availability counting, so a component whose other
 *    monitors are all up also reads `maintenance`, while a down monitor still
 *    surfaces as an outage.
 * 3. availability (`down` = heartbeat `down` outside maintenance):
 *    - `worst` (default): all down → `major_outage`; some down → `partial_outage`.
 *    - `any`: all down → `major_outage`; otherwise one live monitor keeps the
 *      component up and evaluation falls through to latency.
 * 4. latency: when the effective threshold (`component.degradedLatencyMs` over
 *    the page-level `pageDegradedLatencyMs`) is a positive number, any
 *    non-down state above it → `degraded` (strictly greater than).
 * 5. all states pending/maintenance → `unknown` — nothing conclusive yet.
 * 6. otherwise → `operational`.
 *
 * `pending` and `maintenance` states count toward the total but never toward
 * down.
 */
export function componentStatus(
  component: StatusPageComponent,
  states: ComponentMonitorState[],
  pageDegradedLatencyMs?: number,
): ComponentStatus {
  if (states.length === 0) return 'unknown'

  const derived = states.map((state) => ({
    // Only a heartbeat outside a maintenance window counts as down.
    down: state.status === 'down' && !state.inMaintenance,
    // The window flag and the `maintenance` heartbeat status agree in practice; accept either.
    inMaintenance: state.inMaintenance || state.status === 'maintenance',
    // `pending`/`maintenance` heartbeats carry no availability verdict.
    nonDecision: state.status === 'pending' || state.status === 'maintenance',
    latencyMs: state.latencyMs,
  }))

  // Maintenance monitors are treated as up: they never mask an actual outage
  // (a down monitor still surfaces below), and a component whose every other
  // monitor is up is itself in maintenance.
  const downCount = derived.filter((state) => state.down).length
  if (downCount === 0 && derived.some((state) => state.inMaintenance)) return 'maintenance'

  if (downCount === derived.length) return 'major_outage'
  if ((component.aggregation ?? 'worst') === 'worst' && downCount > 0) return 'partial_outage'

  const threshold = component.degradedLatencyMs ?? pageDegradedLatencyMs
  if (threshold !== undefined && threshold > 0) {
    const breached = derived.some(
      (state) => !state.down && state.latencyMs !== null && state.latencyMs > threshold,
    )
    if (breached) return 'degraded'
  }

  if (derived.every((state) => state.nonDecision)) return 'unknown'
  return 'operational'
}

/** Worst-of precedence for the page badge, most severe first. */
const OVERALL_PRECEDENCE: readonly ComponentStatus[] = [
  'major_outage',
  'partial_outage',
  'degraded',
  'maintenance',
  'unknown',
]

/**
 * Overall page severity: major outage > partial outage > degraded >
 * maintenance > unknown > operational. An empty component list (page without
 * a structure) is `unknown`.
 */
export function overallStatus(statuses: ComponentStatus[]): OverallStatus {
  if (statuses.length === 0) return 'unknown'
  for (const status of OVERALL_PRECEDENCE) {
    if (statuses.includes(status)) return status
  }
  return 'operational'
}
