<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { errorMessage, fetchIncidents } from '../api.js'
import type { Incident } from '../api.js'
import Badge from '../components/ui/Badge.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import Icon from '../components/ui/Icon.vue'
import Table from '../components/ui/Table.vue'
import Tabs from '../components/ui/Tabs.vue'
import type { TableColumn } from '../components/ui/table.js'
import { formatDateTime, formatDuration, relativeTime } from '../format.js'

const POLL_INTERVAL_MS = 10000

const FILTERS = [
  { id: 'active', label: 'Active' },
  { id: 'resolved', label: 'Resolved' },
] as const

const filter = ref<string>('active')
const incidents = ref<Incident[]>([])
const loadError = ref<string | null>(null)
const loadedOnce = ref(false)
const now = ref(Date.now())

let pollTimer: number | null = null
let refreshInFlight = false

function durationMs(incident: Incident): number {
  const openedAt = Date.parse(incident.openedAt)
  if (Number.isNaN(openedAt)) return 0
  const end = incident.resolvedAt === null ? now.value : Date.parse(incident.resolvedAt)
  return Math.max(0, end - openedAt)
}

const columns = computed<TableColumn<Incident>[]>(() => {
  const list: TableColumn<Incident>[] = [
    { key: 'monitorName', label: 'Monitor', sortable: true, width: '200px' },
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
  if (filter.value === 'resolved') {
    list.push({
      key: 'resolvedAt',
      label: 'Resolved',
      sortable: true,
      width: '150px',
      value: (row) => (row.resolvedAt === null ? null : Date.parse(row.resolvedAt)),
    })
  }
  return list
})

async function refresh(): Promise<void> {
  if (refreshInFlight) return
  refreshInFlight = true
  try {
    const loaded = await fetchIncidents(filter.value === 'active')
    incidents.value =
      filter.value === 'active' ? loaded : loaded.filter((incident) => incident.resolvedAt !== null)
    now.value = Date.now()
    loadError.value = null
  } catch (error) {
    loadError.value = errorMessage(error, 'Could not load incidents.')
  } finally {
    refreshInFlight = false
    loadedOnce.value = true
  }
}

watch(filter, () => {
  loadedOnce.value = false
  void refresh()
})

onMounted(() => {
  void refresh()
  pollTimer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS)
})

onUnmounted(() => {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
})
</script>

<template>
  <div class="view">
    <Tabs v-model="filter" :tabs="FILTERS">
      <template #tab-active>
        <p class="tab-note">Incidents that have not recovered yet, newest first.</p>
      </template>
      <template #tab-resolved>
        <p class="tab-note">Closed incidents from the retention window, most recent first.</p>
      </template>
    </Tabs>

    <p v-if="loadError !== null" class="banner" role="alert">{{ loadError }}</p>

    <section class="panel">
      <Table :columns="columns" :rows="incidents" :loading="!loadedOnce" :row-key="(row) => row.id">
        <template #empty>
          <EmptyState
            :title="filter === 'active' ? 'No active incidents' : 'No resolved incidents'"
            :description="
              filter === 'active'
                ? 'Every monitor is within its expected state.'
                : 'Incidents appear here once they recover.'
            "
          >
            <template #icon><Icon name="incidents" :size="18" /></template>
          </EmptyState>
        </template>

        <template #cell-monitorName="{ row }">
          <span class="cell-strong">{{ row.monitorName }}</span>
        </template>

        <template #cell-title="{ row }">
          <div class="cell-stack">
            <span>{{ row.title }}</span>
            <span v-if="row.body !== null" class="cell-muted">{{ row.body }}</span>
          </div>
        </template>

        <template #cell-openedAt="{ row }">
          <span :title="formatDateTime(row.openedAt)">{{ relativeTime(row.openedAt, now) }}</span>
        </template>

        <template #cell-duration="{ row }">
          <span class="tabular">{{ formatDuration(durationMs(row)) }}</span>
        </template>

        <template #cell-status="{ row }">
          <Badge :variant="row.resolvedAt === null ? 'error' : 'success'" dot>
            {{ row.resolvedAt === null ? 'Ongoing' : 'Resolved' }}
          </Badge>
        </template>

        <template #cell-resolvedAt="{ row }">
          <span v-if="row.resolvedAt !== null" :title="formatDateTime(row.resolvedAt)">
            {{ relativeTime(row.resolvedAt, now) }}
          </span>
          <span v-else>—</span>
        </template>
      </Table>
    </section>

    <p class="refresh-note">Refreshing every 10 seconds.</p>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.tab-note {
  color: var(--muted);
  font-size: 13px;
}

.panel {
  overflow: hidden;
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.cell-strong {
  font-weight: 550;
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

.banner {
  padding: var(--space-3) var(--space-4);
  background-color: var(--error-soft);
  border: 1px solid color-mix(in srgb, var(--error) 40%, transparent);
  border-radius: var(--radius);
  color: var(--error);
  font-size: 13px;
}

.refresh-note {
  color: var(--muted);
  font-size: 12px;
}
</style>
