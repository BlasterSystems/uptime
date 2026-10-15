<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { deleteMonitor, errorMessage, fetchMonitors, fetchTags } from '../api.js'
import type { Monitor, Tag } from '../api.js'
import MonitorCard from '../components/MonitorCard.vue'
import MonitorForm from '../components/MonitorForm.vue'
import Badge from '../components/ui/Badge.vue'
import Button from '../components/ui/Button.vue'
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

    const latency = monitor.latestHeartbeat?.latencyMs
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
  void refresh()
  void refreshTags()
}

function applyHeartbeat(event: RealtimeHeartbeatEvent): void {
  const monitor = monitors.value.find((item) => item.id === event.monitorId)
  if (monitor === undefined) return
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
      <div class="stats">
        <span class="stat">
          <span class="stat-dot dot-success" aria-hidden="true" />
          <strong>{{ summary.up }}</strong> up
        </span>
        <span class="stat">
          <span class="stat-dot dot-error" aria-hidden="true" />
          <strong>{{ summary.down }}</strong> down
        </span>
        <span v-if="summary.pending > 0" class="stat">
          <span class="stat-dot dot-neutral" aria-hidden="true" />
          <strong>{{ summary.pending }}</strong> pending
        </span>
        <span v-if="summary.maintenance > 0" class="stat">
          <span class="stat-dot dot-warning" aria-hidden="true" />
          <strong>{{ summary.maintenance }}</strong> maintenance
        </span>
        <span class="stat stat-divider" aria-hidden="true" />
        <span class="stat">
          avg latency
          <strong>{{ formatLatency(summary.avgLatency) }}</strong>
        </span>
        <span class="stat muted-stat">
          {{ summary.total }} monitor{{ summary.total === 1 ? '' : 's' }}
        </span>
      </div>
      <Button variant="primary" @click="formOpen = true">
        <Icon name="plus" :size="14" />
        Add monitor
      </Button>
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

    <p v-if="loadError !== null" class="banner" role="alert">{{ loadError }}</p>

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

    <section v-else class="monitor-grid" aria-label="Monitors">
      <MonitorCard
        v-for="monitor in visibleMonitors"
        :key="monitor.id"
        :monitor="monitor"
        @open="openMonitor"
        @delete="requestDelete"
      />
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
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-3) var(--space-4);
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.stats {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex-wrap: wrap;
  margin-right: auto;
}

.stat {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 13px;
}

.stat strong {
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}

.stat-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

/* Shape-first states: ■ recorded, ◆ alarm, ○ pending. */
.dot-success {
  background-color: var(--success);
  border-radius: 0;
}

.dot-error {
  background-color: var(--thread);
  border-radius: 0;
  transform: rotate(45deg);
}

.dot-warning {
  background-color: var(--warning);
}

.dot-neutral {
  background-color: var(--muted);
}

.stat-divider {
  width: 1px;
  height: 16px;
  padding: 0;
  background-color: var(--border);
}

.muted-stat {
  font-variant-numeric: tabular-nums;
}

.filters {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.filter-chip {
  display: inline-flex;
  align-items: center;
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

.filter-chip:hover {
  color: var(--ink);
}

.filter-chip.is-active {
  background-color: transparent;
  border-color: var(--ink);
  color: var(--ink);
}

.chip-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.banner {
  padding: var(--space-3) var(--space-4);
  background-color: var(--error-soft);
  border: 1px solid color-mix(in srgb, var(--error) 40%, transparent);
  border-radius: var(--radius);
  color: var(--thread-ink);
  font-size: 13px;
}

.loading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6);
  color: var(--muted);
  font-size: 13px;
}

.monitor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--space-4);
}

.refresh-note {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--muted);
  font-size: 12px;
}
</style>
