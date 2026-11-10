<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { deleteMonitor, errorMessage, fetchMonitors, fetchTags } from '../api.js'
import type { Monitor, Tag } from '../api.js'
import MonitorCard from '../components/MonitorCard.vue'
import MonitorForm from '../components/MonitorForm.vue'
import AlertRow from '../components/ui/AlertRow.vue'
import Badge from '../components/ui/Badge.vue'
import Button from '../components/ui/Button.vue'
import StatCard from '../components/ui/StatCard.vue'
import ConfirmDialog from '../components/ui/ConfirmDialog.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import Icon from '../components/ui/Icon.vue'
import Spinner from '../components/ui/Spinner.vue'
import { useToast } from '../components/ui/toast.js'
import { formatLatency } from '../format.js'
import { realtimeState, subscribeRealtime } from '../realtime.js'
import type {
  RealtimeEvent,
  RealtimeHeartbeatEvent,
  RealtimeMaintenanceEvent,
} from '../realtime.js'

/** Full reconcile while the SSE stream is live; polling cadence otherwise. */
const RECONCILE_LIVE_MS = 30_000
const POLL_FALLBACK_MS = 10_000

const router = useRouter()
const monitors = ref<Monitor[]>([])
const tags = ref<Tag[]>([])
const loadError = ref<string | null>(null)
const loadedOnce = ref(false)
const formOpen = ref(false)
const activeTagId = ref<number | null>(null)
const pendingDelete = ref<Monitor | null>(null)
const deleting = ref(false)

const toast = useToast()
let pollTimer: number | null = null
let reconcileTimer: number | null = null
let unsubscribeRealtime: (() => void) | null = null
let refreshInFlight = false

/** Monitor ids with a just-arrived beat; drives the row wash flash. */
const freshIds = reactive(new Set<number>())

function markFresh(id: number): void {
  freshIds.add(id)
  window.setTimeout(() => freshIds.delete(id), 950)
}

const summary = computed(() => {
  let up = 0
  let down = 0
  let pending = 0
  let maintenance = 0
  let latencySum = 0
  let latencyCount = 0
  for (const monitor of monitors.value) {
    const status = monitor.latestHeartbeat?.status ?? 'pending'
    if (status === 'up') up += 1
    else if (status === 'down') down += 1
    else if (status === 'maintenance') maintenance += 1
    else pending += 1

    // Average latency measures successful checks only — a down beat's elapsed
    // time is failure evidence, not a sample.
    const beat = monitor.latestHeartbeat
    const latency = beat !== null && beat.status !== 'down' ? beat.latencyMs : undefined
    if (typeof latency === 'number') {
      latencySum += latency
      latencyCount += 1
    }
  }
  return {
    up,
    down,
    pending,
    maintenance,
    total: monitors.value.length,
    latencyCount,
    avgLatency: latencyCount === 0 ? null : Math.round(latencySum / latencyCount),
  }
})

const visibleMonitors = computed(() =>
  activeTagId.value === null
    ? monitors.value
    : monitors.value.filter((monitor) => monitor.tags.some((tag) => tag.id === activeTagId.value)),
)

async function refresh(): Promise<void> {
  if (refreshInFlight) return
  refreshInFlight = true
  try {
    monitors.value = await fetchMonitors()
    loadError.value = null
  } catch (error) {
    loadError.value = errorMessage(error, 'Could not load monitors.')
  } finally {
    refreshInFlight = false
    loadedOnce.value = true
  }
}

/** Tags only drive the filter row; a failure there must not hide the dashboard. */
async function refreshTags(): Promise<void> {
  try {
    tags.value = await fetchTags()
  } catch {
    tags.value = []
  }
}

function toggleTagFilter(id: number): void {
  activeTagId.value = activeTagId.value === id ? null : id
}

function requestDelete(id: number): void {
  pendingDelete.value = monitors.value.find((monitor) => monitor.id === id) ?? null
}

async function confirmDelete(): Promise<void> {
  if (pendingDelete.value === null) return
  const monitor = pendingDelete.value
  deleting.value = true
  try {
    await deleteMonitor(monitor.id)
    toast.success('Monitor deleted', monitor.name)
    pendingDelete.value = null
    await refresh()
  } catch (error) {
    toast.error('Could not delete the monitor', errorMessage(error, 'Try again.'))
  } finally {
    deleting.value = false
  }
}

function handleCreated(monitor: Monitor): void {
  toast.success('Monitor created', monitor.name)
  markFresh(monitor.id)
  void refresh()
  void refreshTags()
}

function applyHeartbeat(event: RealtimeHeartbeatEvent): void {
  const monitor = monitors.value.find((item) => item.id === event.monitorId)
  if (monitor === undefined) return
  markFresh(monitor.id)
  const previous = monitor.latestHeartbeat
  monitor.latestHeartbeat = {
    status: event.status,
    latencyMs: event.latencyMs,
    time: event.time,
    // SSE heartbeats carry no body; keep the last snippet only while still down.
    responseSnippet:
      event.status === 'down' && previous?.status === 'down' ? previous.responseSnippet : null,
  }
}

function applyMaintenance(event: RealtimeMaintenanceEvent): void {
  const monitor = monitors.value.find((item) => item.id === event.monitorId)
  if (monitor === undefined) return
  if (event.under) {
    monitor.latestHeartbeat = {
      status: 'maintenance',
      latencyMs: monitor.latestHeartbeat?.latencyMs ?? null,
      time: event.time,
      responseSnippet: null,
    }
    return
  }
  // Leaving maintenance: the resulting status is unknown, so reconcile shortly.
  scheduleReconcile()
}

function scheduleReconcile(): void {
  if (reconcileTimer !== null) return
  reconcileTimer = window.setTimeout(() => {
    reconcileTimer = null
    void refresh()
  }, 1000)
}

function handleRealtimeEvent(event: RealtimeEvent): void {
  if (event.type === 'heartbeat') applyHeartbeat(event)
  else if (event.type === 'maintenance') applyMaintenance(event)
}

function applyPollInterval(): void {
  if (pollTimer !== null) window.clearInterval(pollTimer)
  pollTimer = window.setInterval(
    () => void refresh(),
    realtimeState.status === 'live' ? RECONCILE_LIVE_MS : POLL_FALLBACK_MS,
  )
}

function openMonitor(id: number): void {
  void router.push({ name: 'monitor-detail', params: { id } })
}

watch(() => realtimeState.status, applyPollInterval)

onMounted(() => {
  void refresh()
  void refreshTags()
  unsubscribeRealtime = subscribeRealtime(handleRealtimeEvent)
  applyPollInterval()
})

onUnmounted(() => {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
  if (reconcileTimer !== null) {
    window.clearTimeout(reconcileTimer)
    reconcileTimer = null
  }
  unsubscribeRealtime?.()
  unsubscribeRealtime = null
})
</script>

<template>
  <div class="view">
    <section class="summary" aria-label="Status summary">
      <div class="stat-grid">
        <StatCard
          label="Monitors up"
          :value="String(summary.up)"
          :sub="`of ${summary.total} monitor${summary.total === 1 ? '' : 's'}.`"
          basis="recorded"
          basis-label="Recorded · latest checks"
          :explain="{
            text: 'Monitors whose latest heartbeat is up.',
            rows: [
              ['Tracked', String(summary.total)],
              ['Maintenance', String(summary.maintenance)],
            ],
            total: ['Up', String(summary.up)],
          }"
        />
        <StatCard
          label="Down"
          :value="String(summary.down)"
          :sub="summary.down > 0 ? 'At least one check is failing.' : 'No failing checks.'"
          :basis="summary.down > 0 ? 'decision' : 'recorded'"
          :basis-label="summary.down > 0 ? 'Decision · needs owner' : 'Recorded · latest checks'"
          :explain="{
            text: 'Monitors whose latest heartbeat is down.',
            rows: [['Tracked', String(summary.total)]],
            total: ['Down', String(summary.down)],
          }"
        />
        <StatCard
          label="Avg response"
          :value="formatLatency(summary.avgLatency)"
          sub="Successful checks only."
          basis="estimated"
          basis-label="Estimated · latest checks"
          :explain="{
            text: 'Mean of the latest successful check per monitor. A down beat’s elapsed time is failure evidence, not a sample.',
            rows: [['Samples', String(summary.latencyCount)]],
            total: ['Mean', formatLatency(summary.avgLatency)],
          }"
        />
        <StatCard
          label="Pending"
          :value="String(summary.pending)"
          sub="Awaiting the first heartbeat."
          basis="estimated"
          basis-label="Estimated · no data yet"
        />
      </div>
      <div class="summary-actions">
        <Button variant="primary" @click="formOpen = true">
          <Icon name="plus" :size="14" />
          Add monitor
        </Button>
      </div>
    </section>

    <div v-if="tags.length > 0" class="filters" role="group" aria-label="Filter by tag">
      <button
        type="button"
        class="filter-chip"
        :class="{ 'is-active': activeTagId === null }"
        :aria-pressed="activeTagId === null"
        @click="activeTagId = null"
      >
        All
      </button>
      <button
        v-for="tag in tags"
        :key="tag.id"
        type="button"
        class="filter-chip"
        :class="{ 'is-active': activeTagId === tag.id }"
        :aria-pressed="activeTagId === tag.id"
        @click="toggleTagFilter(tag.id)"
      >
        <span class="chip-dot" :style="{ backgroundColor: tag.color }" aria-hidden="true" />
        {{ tag.name }}
      </button>
    </div>

    <AlertRow v-if="loadError !== null">{{ loadError }}</AlertRow>

    <div v-if="!loadedOnce" class="loading">
      <Spinner />
      <span>Loading monitors…</span>
    </div>

    <EmptyState
      v-else-if="monitors.length === 0"
      title="No monitors yet"
      description="Add an HTTP monitor to poll a URL, or a push monitor to wait for incoming heartbeats."
    >
      <template #icon><Icon name="dashboard" :size="18" /></template>
      <template #actions>
        <Button variant="primary" @click="formOpen = true">Add monitor</Button>
      </template>
    </EmptyState>

    <EmptyState
      v-else-if="visibleMonitors.length === 0"
      title="No monitors match this tag"
      description="Clear the filter to see every monitor again."
    >
      <template #actions>
        <Button variant="secondary" @click="activeTagId = null">Clear filter</Button>
      </template>
    </EmptyState>

    <section v-else class="panel monitors" aria-label="Monitors">
      <header class="panel-head">
        <span class="panel-label">Monitors</span>
        <span class="panel-aside">{{ visibleMonitors.length }} shown</span>
      </header>
      <div class="monitor-list">
        <MonitorCard
          v-for="monitor in visibleMonitors"
          :key="monitor.id"
          :monitor="monitor"
          :fresh="freshIds.has(monitor.id)"
          @open="openMonitor"
          @delete="requestDelete"
        />
      </div>
    </section>

    <footer v-if="loadedOnce" class="refresh-note">
      <Badge :variant="realtimeState.status === 'live' ? 'success' : 'neutral'" dot>
        {{
          realtimeState.status === 'live'
            ? 'Live'
            : realtimeState.status === 'connecting'
              ? 'Connecting'
              : 'Polling'
        }}
      </Badge>
      <span v-if="realtimeState.status === 'live'">
        Real-time updates · full refresh every 30 seconds
      </span>
      <span v-else>Refreshing every 10 seconds</span>
    </footer>

    <MonitorForm :open="formOpen" @created="handleCreated" @close="formOpen = false" />

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete monitor"
      :message="
        pendingDelete === null
          ? undefined
          : `“${pendingDelete.name}” and its heartbeat history will be permanently removed.`
      "
      confirm-label="Delete monitor"
      danger
      :loading="deleting"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
}

@media (max-width: 1100px) {
  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .stat-grid {
    grid-template-columns: 1fr;
  }
}

.summary-actions {
  display: flex;
  justify-content: flex-end;
}

.filters {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

/* DS v1.1 .bs-filter: hairline via inset box-shadow, 1.5px ink when active. */
.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: var(--control-sm);
  padding: 0 12px;
  background-color: transparent;
  border: 0;
  border-radius: var(--radius-control);
  box-shadow: inset 0 0 0 1px var(--border-2);
  color: var(--text-2);
  font-size: var(--fs-ui);
  cursor: pointer;
  transition:
    box-shadow var(--dur-press),
    color var(--dur-press);
}

.filter-chip:hover {
  box-shadow: inset 0 0 0 1px var(--ink);
  color: var(--ink);
}

.filter-chip.is-active {
  box-shadow: inset 0 0 0 1.5px var(--ink);
  color: var(--ink);
}

.chip-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.loading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6);
  color: var(--muted);
  font-size: var(--fs-small);
}

.panel {
  background-color: var(--surface-card);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-panel);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 24px;
  padding: var(--space-4) var(--space-4) 0;
}

.panel-label {
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-label);
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
}

.panel-aside {
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: var(--fs-data);
}

.monitor-list {
  padding: 0 var(--space-4) var(--space-3);
}

.refresh-note {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-label-sm);
  letter-spacing: var(--tracking-mono);
  text-transform: uppercase;
}
</style>
