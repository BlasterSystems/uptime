<script setup lang="ts">
import { computed } from 'vue'
import type { HeartbeatStatus, Monitor } from '../api.js'

const STATUS_COLORS: Record<HeartbeatStatus, string> = {
  up: '#22c55e',
  down: '#ef4444',
  pending: '#9ca3af',
  maintenance: '#3b82f6',
}

const STATUS_LABELS: Record<HeartbeatStatus, string> = {
  up: 'Up',
  down: 'Down',
  pending: 'Pending',
  maintenance: 'Maintenance',
}

const props = defineProps<{ monitor: Monitor }>()
const emit = defineEmits<{ delete: [id: number] }>()

function relativeTime(iso: string): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return 'unknown'
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function requestDelete(): void {
  if (window.confirm(`Delete monitor "${props.monitor.name}"?`)) {
    emit('delete', props.monitor.id)
  }
}

const view = computed(() => {
  const heartbeat = props.monitor.latestHeartbeat
  const status: HeartbeatStatus = heartbeat?.status ?? 'pending'
  return {
    statusColor: STATUS_COLORS[status],
    statusLabel: STATUS_LABELS[status],
    latencyText: heartbeat?.latencyMs != null ? `${heartbeat.latencyMs} ms` : null,
    lastCheckText: heartbeat ? relativeTime(heartbeat.time) : null,
    snippet: status === 'down' ? (heartbeat?.responseSnippet ?? null) : null,
  }
})
</script>

<template>
  <article class="card">
    <div class="card-header">
      <span
        class="status-dot"
        :style="{ backgroundColor: view.statusColor }"
        :title="view.statusLabel"
        aria-hidden="true"
      />
      <h2 class="card-name" :title="monitor.name">{{ monitor.name }}</h2>
      <span v-if="!monitor.active" class="badge">paused</span>
      <button
        type="button"
        class="btn btn-danger card-delete"
        :aria-label="`Delete monitor ${monitor.name}`"
        @click="requestDelete"
      >
        Delete
      </button>
    </div>

    <p class="card-url" :title="monitor.config.url">{{ monitor.config.url }}</p>

    <dl class="card-meta">
      <div class="meta-item">
        <dt>status</dt>
        <dd>{{ view.statusLabel }}</dd>
      </div>
      <div v-if="view.latencyText" class="meta-item">
        <dt>latency</dt>
        <dd>{{ view.latencyText }}</dd>
      </div>
      <div v-if="view.lastCheckText" class="meta-item">
        <dt>last check</dt>
        <dd>{{ view.lastCheckText }}</dd>
      </div>
      <div class="meta-item">
        <dt>interval</dt>
        <dd>{{ monitor.intervalS }}s</dd>
      </div>
    </dl>

    <pre v-if="view.snippet" class="card-snippet">{{ view.snippet }}</pre>
  </article>
</template>
