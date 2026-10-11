/** Display metadata for status-page severities, incidents and subscriptions. */

import type {
  HeartbeatStatus,
  StatusAggregation,
  StatusIncidentImpact,
  StatusIncidentSource,
  StatusIncidentStatus,
  StatusSeverity,
  StatusSubscriptionEvent,
} from './api.js'

/** Variants accepted by the `Badge` component. */
export type ToneVariant = 'neutral' | 'accent' | 'success' | 'warning' | 'error'

export interface SeverityMeta {
  /** Short label, used on component cards and admin tables. */
  label: string
  /** Banner sentence shown for the overall severity. */
  banner: string
  variant: ToneVariant
}

/** Worst first; the order also documents the severity ladder. */
export const SEVERITY_META: Record<StatusSeverity, SeverityMeta> = {
  major_outage: { label: 'Major outage', banner: 'Major outage', variant: 'error' },
  partial_outage: { label: 'Partial outage', banner: 'Partial outage', variant: 'error' },
  degraded: { label: 'Degraded', banner: 'Degraded performance', variant: 'warning' },
  maintenance: { label: 'Maintenance', banner: 'Scheduled maintenance', variant: 'warning' },
  operational: { label: 'Operational', banner: 'All systems operational', variant: 'success' },
  unknown: { label: 'Unknown', banner: 'Status unknown', variant: 'neutral' },
}

export interface HeartbeatMeta {
  label: string
  variant: ToneVariant
}

export const HEARTBEAT_META: Record<HeartbeatStatus, HeartbeatMeta> = {
  up: { label: 'Up', variant: 'success' },
  down: { label: 'Down', variant: 'error' },
  pending: { label: 'Pending', variant: 'neutral' },
  maintenance: { label: 'Maintenance', variant: 'warning' },
}

export const INCIDENT_STATUS_META: Record<StatusIncidentStatus, HeartbeatMeta> = {
  investigating: { label: 'Investigating', variant: 'error' },
  identified: { label: 'Identified', variant: 'warning' },
  monitoring: { label: 'Monitoring', variant: 'warning' },
  resolved: { label: 'Resolved', variant: 'success' },
}

/** Lifecycle order of incident updates; also the options of the update modal. */
export const INCIDENT_STATUSES: readonly StatusIncidentStatus[] = [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
]

export const IMPACT_META: Record<StatusIncidentImpact, HeartbeatMeta> = {
  none: { label: 'No impact', variant: 'neutral' },
  minor: { label: 'Minor', variant: 'warning' },
  major: { label: 'Major', variant: 'error' },
  critical: { label: 'Critical', variant: 'error' },
}

export const IMPACT_LEVELS: readonly StatusIncidentImpact[] = ['none', 'minor', 'major', 'critical']

export const SOURCE_LABELS: Record<StatusIncidentSource, string> = {
  auto: 'Auto',
  manual: 'Manual',
}

export const AGGREGATION_LABELS: Record<StatusAggregation, string> = {
  worst: 'Worst monitor decides',
  any: 'Up when any monitor is up',
}

export const SUBSCRIPTION_EVENTS: readonly StatusSubscriptionEvent[] = [
  'incident_open',
  'incident_update',
  'incident_resolved',
  'maintenance_start',
  'maintenance_end',
]

export const SUBSCRIPTION_EVENT_LABELS: Record<StatusSubscriptionEvent, string> = {
  incident_open: 'Incident opened',
  incident_update: 'Incident updated',
  incident_resolved: 'Incident resolved',
  maintenance_start: 'Maintenance started',
  maintenance_end: 'Maintenance ended',
}
