<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  deleteMonitor,
  errorMessage,
  fetchHeartbeats,
  fetchIncidents,
  fetchMonitors,
  fetchUptime,
} from '../api.js'
import type { Heartbeat, HeartbeatStatus, Incident, Monitor, UptimeStats } from '../api.js'
import {
  formatDateTime,
  formatDuration,
  formatInterval,
  formatLatency,
  relativeTime,
} from '../format.js'
import { MONITOR_TYPE_LABELS, monitorTarget } from '../monitorDisplay.js'
import { realtimeState, subscribeRealtime } from '../realtime.js'
import type { RealtimeEvent } from '../realtime.js'
import ResponseChart from '../components/charts/ResponseChart.vue'
import HeartbeatStrip from '../components/charts/HeartbeatStrip.vue'
import type { ChartMarker, LatencyPoint, StripCell, StripTone } from '../components/charts/types.js'
import MonitorForm from '../components/MonitorForm.vue'
import Badge from '../components/ui/Badge.vue'
import Button from '../components/ui/Button.vue'
import ConfirmDialog from '../components/ui/ConfirmDialog.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import Icon from '../components/ui/Icon.vue'
import Spinner from '../components/ui/Spinner.vue'
import Table from '../components/ui/Table.vue'
import type { TableColumn } from '../components/ui/table.js'
import { useToast } from '../components/ui/toast.js'

const HEARTBEAT_LIMIT = 1000
const POLL_LIVE_MS = 60_000
const POLL_FALLBACK_MS = 20_000
const DERIVED_REFRESH_DELAY_MS = 1000
const DAY_COUNT = 90
const DAY_MS = 24 * 60 * 60 * 1000

const UPTIME_RANGES = [
  { hours: 24, label: '24h' },
  { hours: 168, label: '7d' },
  { hours: 720, label: '30d' },
  { hours: 8760, label: '365d' },
] as const

type UptimeRange = (typeof UPTIME_RANGES)[number]

const STATUS_META: Record<
  HeartbeatStatus,
  { label: string; variant: 'success' | 'error' | 'warning' | 'neutral' }
> = {
  up: { label: 'Up', variant: 'success' },
  down: { label: 'Down', variant: 'error' },
  pending: { label: 'Pending', variant: 'neutral' },
  maintenance: { label: 'Maintenance', variant: 'warning' },
}

interface DayBucket {
  date: string
  label: string
  up: number
  down: number
  pending: number
  maintenance: number
  total: number
}

const route = useRoute()
const router = useRouter()
const toast = useToast()

const monitor = ref<Monitor | null>(null)
const heartbeats = ref<Heartbeat[]>([])
const incidents = ref<Incident[]>([])
const uptime = ref<Record<number, UptimeStats | null>>({})
const liveHeartbeat = ref<Heartbeat | null>(null)
const selectedRange = ref<number>(24)
const loading = ref(true)
const loadError = ref<string | null>(null)
const editOpen = ref(false)
const deleteOpen = ref(false)
const deleting = ref(false)
const now = ref(Date.now())

let pollTimer: number | null = null
let derivedTimer: number | null = null
let unsubscribe: (() => void) | null = null
let refreshInFlight = false

const monitorId = computed<number | null>(() => {
  const raw = route.params.id
  const value = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isNaN(value) ? null : value
})

/** Latest state for the header; a live SSE heartbeat outranks the polled one. */
const headerHeartbeat = computed<Heartbeat | null>(
  () => liveHeartbeat.value ?? monitor.value?.latestHeartbeat ?? null,
)

const statusMeta = computed(() => STATUS_META[headerHeartbeat.value?.status ?? 'pending'])

const target = computed(() => {
  const current = monitor.value
  return current === null ? '—' : monitorTarget(current)
})

/** Network and database endpoints read better in the monospace font. */
const targetMono = computed(() => {
  const current = monitor.value
  return current !== null && current.type !== 'push' && current.type !== 'group'
})

const lastCheckRelative = computed(() => {
  const heartbeat = headerHeartbeat.value
  return heartbeat === null ? null : relativeTime(heartbeat.time, now.value)
})

const lastCheckExact = computed(() => {
  const heartbeat = headerHeartbeat.value
  return heartbeat === null ? undefined : formatDateTime(heartbeat.time)
})

/** Newest down heartbeat carries the response body that explains the failure. */
const downSnippet = computed(() => {
  const heartbeat = heartbeats.value.find((item) => item.status === 'down')
  return heartbeat === undefined ? null : heartbeat.responseSnippet
})

/* Response-time chart: heartbeats from the trailing 24 hours, oldest first. */
const recentHeartbeats = computed(() => {
  const cutoff = Date.now() - DAY_MS
  return heartbeats.value
    .filter((heartbeat) => Date.parse(heartbeat.time) >= cutoff)
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
})

const latencyPoints = computed<LatencyPoint[]>(() =>
  recentHeartbeats.value
    .filter(
      (heartbeat): heartbeat is Heartbeat & { latencyMs: number } =>
        heartbeat.status === 'up' && heartbeat.latencyMs !== null,
    )
    .map((heartbeat) => ({ time: Date.parse(heartbeat.time), latencyMs: heartbeat.latencyMs })),
)

const chartMarkers = computed<ChartMarker[]>(() =>
  recentHeartbeats.value
    .filter(
      (heartbeat): heartbeat is Heartbeat & { status: 'down' | 'maintenance' } =>
        heartbeat.status === 'down' || heartbeat.status === 'maintenance',
    )
    .map((heartbeat) => ({
      time: Date.parse(heartbeat.time),
      status: heartbeat.status,
      title: `${formatDateTime(heartbeat.time)} — ${heartbeat.status}`,
    })),
)

/** Domain spans every beat of the window, so pending beats still stretch the axis. */
const chartDomain = computed<{ min: number; max: number } | null>(() => {
  const times = recentHeartbeats.value.map((heartbeat) => Date.parse(heartbeat.time))
  if (times.length === 0) return null
  return { min: Math.min(...times), max: Math.max(...times) }
})

/* 90-day heartbeat strip, one cell per local calendar day, oldest first. */
function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function dayTitle(bucket: DayBucket): string {
  if (bucket.total === 0) return `${bucket.label} — no data`
  const parts = [`${bucket.up} up`, `${bucket.down} down`]
  if (bucket.pending > 0) parts.push(`${bucket.pending} pending`)
  if (bucket.maintenance > 0) parts.push(`${bucket.maintenance} maintenance`)
  return `${bucket.label} — ${parts.join(', ')}`
}

const dayCells = computed<StripCell[]>(() => {
  const buckets: DayBucket[] = []
  const byDate = new Map<string, DayBucket>()
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  for (let offset = DAY_COUNT - 1; offset >= 0; offset -= 1) {
    const date = new Date(today)
    date.setDate(today.getDate() - offset)
    const bucket: DayBucket = {
      date: dayKey(date),
      label: date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
      up: 0,
      down: 0,
      pending: 0,
      maintenance: 0,
      total: 0,
    }
    buckets.push(bucket)
    byDate.set(bucket.date, bucket)
  }

  for (const heartbeat of heartbeats.value) {
    const timestamp = Date.parse(heartbeat.time)
    if (Number.isNaN(timestamp)) continue
    const bucket = byDate.get(dayKey(new Date(timestamp)))
    if (bucket === undefined) continue
    bucket.total += 1
    if (heartbeat.status === 'up') bucket.up += 1
    else if (heartbeat.status === 'down') bucket.down += 1
    else if (heartbeat.status === 'maintenance') bucket.maintenance += 1
    else bucket.pending += 1
  }

  return buckets.map((bucket) => {
    let tone: StripTone = 'empty'
    if (bucket.down > 0) tone = 'down'
    else if (bucket.pending > 0) tone = 'pending'
    else if (bucket.maintenance > 0 && bucket.up === 0) tone = 'maintenance'
    else if (bucket.total > 0) tone = 'up'
    return { key: bucket.date, tone, title: dayTitle(bucket) }
  })
})

/* Incidents table. */
function durationMs(incident: Incident): number {
  const openedAt = Date.parse(incident.openedAt)
  if (Number.isNaN(openedAt)) return 0
  const end = incident.resolvedAt === null ? now.value : Date.parse(incident.resolvedAt)
  return Math.max(0, end - openedAt)
}

const incidentColumns: TableColumn<Incident>[] = [
  { key: 'title', label: 'Incident', sortable: true },
  {
    key: 'openedAt',
    label: 'Opened',
    sortable: true,
    width: '140px',
    value: (row) => Date.parse(row.openedAt),
  },
  {
    key: 'duration',
    label: 'Duration',
    align: 'right',
    width: '120px',
    value: (row) => durationMs(row),
  },
  { key: 'status', label: 'Status', width: '130px' },
]

/* Loading and refresh. */
async function load(silent: boolean): Promise<void> {
  const id = monitorId.value
  if (id === null) {
    monitor.value = null
    heartbeats.value = []
    incidents.value = []
    uptime.value = {}
    loadError.value = null
    loading.value = false
    return
  }
  if (silent && refreshInFlight) return
  refreshInFlight = true
  if (!silent) loading.value = true
  try {
    const [monitors, beats, incidentList, stats] = await Promise.all([
      fetchMonitors(),
      fetchHeartbeats(id, HEARTBEAT_LIMIT),
      fetchIncidents(),
      Promise.all(UPTIME_RANGES.map((range) => fetchUptime(id, range.hours).catch(() => null))),
    ])
    monitor.value = monitors.find((item) => item.id === id) ?? null
    heartbeats.value = beats
    incidents.value = incidentList.filter((incident) => incident.monitorId === id)
    const nextUptime: Record<number, UptimeStats | null> = {}
    UPTIME_RANGES.forEach((range, index) => {
      nextUptime[range.hours] = stats[index] ?? null
    })
    uptime.value = nextUptime
    now.value = Date.now()
    loadError.value = null
  } catch (error) {
    loadError.value = errorMessage(
      error,
      silent ? 'Could not refresh the monitor.' : 'Could not load the monitor.',
    )
  } finally {
    refreshInFlight = false
    if (!silent) loading.value = false
  }
}

function retry(): void {
  void load(false)
}

function openDashboard(): void {
  void router.push({ name: 'dashboard' })
}

function formatUptime(stats: UptimeStats | null | undefined): string {
  if (stats === null || stats === undefined) return '—'
  return stats.uptimePct === 100 ? '100%' : `${stats.uptimePct.toFixed(2)}%`
}

function rangeTitle(range: UptimeRange): string {
  const stats = uptime.value[range.hours] ?? null
  if (stats === null) return `${range.label} uptime — no data`
  return (
    `${range.label} uptime — ${stats.up} up, ${stats.down} down, ` +
    `${stats.maintenance} maintenance, ${stats.total} total`
  )
}

/* Edit and delete. */
function handleSaved(updated: Monitor): void {
  // The form already shows the success toast; just sync local state.
  monitor.value = updated
}

async function confirmDelete(): Promise<void> {
  const current = monitor.value
  if (current === null) return
  deleting.value = true
  try {
    await deleteMonitor(current.id)
    toast.success('Monitor deleted', current.name)
    deleteOpen.value = false
    await router.push({ name: 'dashboard' })
  } catch (error) {
    toast.error('Could not delete the monitor', errorMessage(error, 'Try again.'))
  } finally {
    deleting.value = false
  }
}

/* Realtime updates. */
function scheduleDerivedRefresh(): void {
  if (derivedTimer !== null) return
  derivedTimer = window.setTimeout(() => {
    derivedTimer = null
    void load(true)
  }, DERIVED_REFRESH_DELAY_MS)
}

function handleRealtime(event: RealtimeEvent): void {
  const id = monitorId.value
  if (id === null || event.monitorId !== id) return

  if (event.type === 'heartbeat') {
    const previousSnippet = headerHeartbeat.value?.responseSnippet ?? null
    const heartbeat: Heartbeat = {
      monitorId: event.monitorId,
      status: event.status,
      latencyMs: event.latencyMs,
      responseSnippet: event.status === 'down' ? previousSnippet : null,
      time: event.time,
    }
    liveHeartbeat.value = heartbeat
    if (!heartbeats.value.some((item) => item.time === event.time)) {
      heartbeats.value = [heartbeat, ...heartbeats.value]
    }
    return
  }

  if (event.type === 'incident') {
    scheduleDerivedRefresh()
    return
  }

  if (event.under) {
    const base = headerHeartbeat.value
    liveHeartbeat.value = {
      status: 'maintenance',
      latencyMs: base?.latencyMs ?? null,
      responseSnippet: base?.responseSnippet ?? null,
      time: base?.time ?? event.time,
    }
  } else {
    // Drop the override and let the next reconcile restore the server state.
    liveHeartbeat.value = null
    scheduleDerivedRefresh()
  }
}

/* Polling fallback: slow cadence while SSE is live, faster when it is not. */
function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

function startPolling(): void {
  stopPolling()
  const interval = realtimeState.status === 'live' ? POLL_LIVE_MS : POLL_FALLBACK_MS
  pollTimer = window.setInterval(() => void load(true), interval)
}

watch(monitorId, () => {
  liveHeartbeat.value = null
  monitor.value = null
  heartbeats.value = []
  incidents.value = []
  uptime.value = {}
  editOpen.value = false
  deleteOpen.value = false
  void load(false)
})

watch(
  () => realtimeState.status,
  () => startPolling(),
)

onMounted(() => {
  void load(false)
  unsubscribe = subscribeRealtime(handleRealtime)
  startPolling()
})

onUnmounted(() => {
  if (unsubscribe !== null) {
    unsubscribe()
    unsubscribe = null
  }
  stopPolling()
  if (derivedTimer !== null) {
    window.clearTimeout(derivedTimer)
    derivedTimer = null
  }
})
</script>

<template>
  <div class="view">
    <div v-if="loading" class="loading">
      <Spinner />
      <span>Loading monitor…</span>
    </div>

    <template v-else>
      <div v-if="loadError !== null" class="banner-row">
        <p class="banner" role="alert">{{ loadError }}</p>
        <Button variant="secondary" size="sm" @click="retry">Retry</Button>
      </div>

      <template v-if="monitor !== null">
        <header class="panel detail-head">
          <div class="head-top">
            <RouterLink class="back-link" :to="{ name: 'dashboard' }">
              <Icon name="chevron-left" :size="14" />
              Dashboard
            </RouterLink>
            <div class="head-actions">
              <Button variant="secondary" size="sm" @click="editOpen = true">Edit</Button>
              <Button variant="danger" size="sm" @click="deleteOpen = true">Delete</Button>
            </div>
          </div>

          <div class="head-title">
            <h1 class="head-name">{{ monitor.name }}</h1>
            <Badge :variant="statusMeta.variant" dot>{{ statusMeta.label }}</Badge>
            <Badge variant="accent" mono>{{ MONITOR_TYPE_LABELS[monitor.type] }}</Badge>
            <Badge v-if="!monitor.active" variant="neutral">paused</Badge>
          </div>

          <p class="head-target" :class="{ mono: targetMono }" :title="target">
            {{ target }}
          </p>

          <dl class="head-meta">
            <div class="meta-item">
              <dt>Latency</dt>
              <dd>{{ formatLatency(headerHeartbeat?.latencyMs ?? null) }}</dd>
            </div>
            <div class="meta-item">
              <dt>Last check</dt>
              <dd :title="lastCheckExact">{{ lastCheckRelative ?? 'No heartbeats yet' }}</dd>
            </div>
            <div class="meta-item">
              <dt>Interval</dt>
              <dd>{{ formatInterval(monitor.intervalS) }}</dd>
            </div>
            <div class="meta-item">
              <dt>Retries</dt>
              <dd>{{ monitor.retries }}</dd>
            </div>
          </dl>

          <div v-if="monitor.tags.length > 0" class="head-tags">
            <span v-for="tag in monitor.tags" :key="tag.id" class="tag-chip">
              <span class="tag-dot" :style="{ backgroundColor: tag.color }" aria-hidden="true" />
              {{ tag.name }}
            </span>
          </div>

          <pre v-if="downSnippet !== null" class="snippet">{{ downSnippet }}</pre>
        </header>

        <section class="panel section" aria-label="Uptime">
          <div class="section-head">
            <h2 class="section-title">Uptime</h2>
            <div class="range-chips" role="group" aria-label="Uptime range">
              <button
                v-for="range in UPTIME_RANGES"
                :key="range.hours"
                type="button"
                class="range-chip"
                :class="{ 'is-active': selectedRange === range.hours }"
                :aria-pressed="selectedRange === range.hours"
                :title="rangeTitle(range)"
                @click="selectedRange = range.hours"
              >
                <span>{{ range.label }}</span>
                <strong>{{ formatUptime(uptime[range.hours]) }}</strong>
              </button>
            </div>
          </div>

          <ResponseChart
            :points="latencyPoints"
            :markers="chartMarkers"
            :domain="chartDomain"
            aria-label="Response time over the last 24 hours"
          />
        </section>

        <section class="panel section" aria-label="Heartbeat history">
          <div class="section-head">
            <h2 class="section-title">Heartbeat history</h2>
            <span class="section-note">Last 90 days</span>
          </div>
          <HeartbeatStrip :cells="dayCells" aria-label="90-day heartbeat history" />
        </section>

        <section class="panel" aria-label="Incidents">
          <div class="section-head section-head-pad">
            <h2 class="section-title">Incidents</h2>
          </div>
          <Table :columns="incidentColumns" :rows="incidents" :row-key="(row) => row.id">
            <template #empty>
              <EmptyState
                title="No incidents"
                description="This monitor has not opened any incidents yet."
              >
                <template #icon><Icon name="incidents" :size="18" /></template>
              </EmptyState>
            </template>

            <template #cell-title="{ row }">
              <div class="cell-stack">
                <span>{{ row.title }}</span>
                <span v-if="row.body !== null" class="cell-muted">{{ row.body }}</span>
              </div>
            </template>

            <template #cell-openedAt="{ row }">
              <span :title="formatDateTime(row.openedAt)">
                {{ relativeTime(row.openedAt, now) }}
              </span>
            </template>

            <template #cell-duration="{ row }">
              <span class="tabular">{{ formatDuration(durationMs(row)) }}</span>
            </template>

            <template #cell-status="{ row }">
              <Badge :variant="row.resolvedAt === null ? 'error' : 'success'" dot>
                {{ row.resolvedAt === null ? 'Ongoing' : 'Resolved' }}
              </Badge>
            </template>
          </Table>
        </section>
      </template>

      <EmptyState
        v-else-if="loadError === null"
        title="Monitor not found"
        description="It may have been deleted, or the link is out of date."
      >
        <template #icon><Icon name="dashboard" :size="18" /></template>
        <template #actions>
          <Button variant="primary" @click="openDashboard">Back to dashboard</Button>
        </template>
      </EmptyState>
    </template>

    <MonitorForm
      :open="editOpen"
      :monitor="monitor"
      @saved="handleSaved"
      @close="editOpen = false"
    />

    <ConfirmDialog
      :open="deleteOpen"
      title="Delete monitor"
      :message="
        monitor === null
          ? undefined
          : `“${monitor.name}” and its heartbeat history will be permanently removed.`
      "
      confirm-label="Delete monitor"
      danger
      :loading="deleting"
      @confirm="confirmDelete"
      @cancel="deleteOpen = false"
    />
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.loading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6);
  color: var(--muted);
  font-size: 13px;
}

.banner-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.banner {
  flex-grow: 1;
  padding: var(--space-3) var(--space-4);
  background-color: var(--error-soft);
  border: 1px solid color-mix(in srgb, var(--error) 40%, transparent);
  border-radius: var(--radius);
  color: var(--thread-ink);
  font-size: 13px;
}

.panel {
  overflow: hidden;
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.section-head-pad {
  padding: var(--space-4) var(--space-4) 0;
}

.section-title {
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.section-note {
  color: var(--muted);
  font-size: 12px;
}

.detail-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
}

.head-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.back-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  font-size: 12.5px;
  text-decoration: none;
}

.back-link:hover {
  color: var(--fg);
  text-decoration: none;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.head-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.head-name {
  font-size: 20px;
  font-weight: 600;
}

.head-target {
  color: var(--muted);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.head-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--space-2) var(--space-4);
}

.meta-item {
  min-width: 0;
}

.meta-item dt {
  color: var(--muted);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.meta-item dd {
  margin-top: 1px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.head-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  background-color: transparent;
  border: 1px solid var(--rule-2);
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.tag-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.snippet {
  max-height: 110px;
  padding: var(--space-2) var(--space-3);
  overflow: auto;
  background-color: var(--error-soft);
  border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
  border-radius: var(--radius-sm);
  color: var(--thread-ink);
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.range-chips {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.range-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 10px;
  background-color: transparent;
  border: 1px solid var(--rule-2);
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}

.range-chip:hover {
  color: var(--ink);
}

.range-chip.is-active {
  background-color: transparent;
  border-color: var(--ink);
  color: var(--ink);
}

.range-chip strong {
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.cell-muted {
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.tabular {
  font-variant-numeric: tabular-nums;
}
</style>
