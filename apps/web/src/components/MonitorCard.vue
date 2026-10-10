<script setup lang="ts">
import { computed } from 'vue'
import type { HeartbeatStatus, Monitor } from '../api.js'
import { formatDateTime, formatInterval, formatLatency, relativeTime } from '../format.js'
import Badge from './ui/Badge.vue'
import Button from './ui/Button.vue'

const props = defineProps<{ monitor: Monitor }>()
const emit = defineEmits<{ delete: [id: number] }>()

const STATUS_META: Record<
  HeartbeatStatus,
  { label: string; variant: 'success' | 'error' | 'warning' | 'neutral' }
> = {
  up: { label: 'Up', variant: 'success' },
  down: { label: 'Down', variant: 'error' },
  pending: { label: 'Pending', variant: 'neutral' },
  maintenance: { label: 'Maintenance', variant: 'warning' },
}

const status = computed(() => STATUS_META[props.monitor.latestHeartbeat?.status ?? 'pending'])

const target = computed(() =>
  props.monitor.type === 'push'
    ? 'Waiting for incoming heartbeats'
    : (props.monitor.config.url ?? '—'),
)

const heartbeat = computed(() => props.monitor.latestHeartbeat)

const lastCheck = computed(() => {
  const time = heartbeat.value?.time
  return time === undefined ? null : relativeTime(time)
})

const lastCheckExact = computed(() => {
  const time = heartbeat.value?.time
  return time === undefined ? undefined : formatDateTime(time)
})

const failureSnippet = computed(() =>
  heartbeat.value?.status === 'down' ? heartbeat.value.responseSnippet : null,
)
</script>

<template>
  <article class="card">
    <header class="card-head">
      <span class="status-dot" :class="`dot-${status.variant}`" aria-hidden="true" />
      <h3 class="card-name" :title="monitor.name">{{ monitor.name }}</h3>
      <Badge :variant="status.variant" dot>{{ status.label }}</Badge>
      <Badge v-if="monitor.type === 'push'" variant="accent">push</Badge>
      <Badge v-if="!monitor.active" variant="neutral">paused</Badge>
    </header>

    <p class="card-target mono" :title="target">{{ target }}</p>

    <dl class="card-meta">
      <div class="meta-item">
        <dt>Latency</dt>
        <dd>{{ formatLatency(heartbeat?.latencyMs ?? null) }}</dd>
      </div>
      <div class="meta-item">
        <dt>Last check</dt>
        <dd :title="lastCheckExact">{{ lastCheck ?? 'No heartbeats yet' }}</dd>
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

    <div v-if="monitor.tags.length > 0" class="card-tags">
      <span v-for="tag in monitor.tags" :key="tag.id" class="tag-chip">
        <span class="tag-dot" :style="{ backgroundColor: tag.color }" aria-hidden="true" />
        {{ tag.name }}
      </span>
    </div>

    <pre v-if="failureSnippet !== null" class="card-snippet">{{ failureSnippet }}</pre>

    <footer class="card-foot">
      <span class="card-channels">
        {{
          monitor.channelIds.length === 0
            ? 'Default channels'
            : `${monitor.channelIds.length} channel${monitor.channelIds.length === 1 ? '' : 's'}`
        }}
      </span>
      <Button
        variant="secondary"
        size="sm"
        :aria-label="`Delete monitor ${monitor.name}`"
        @click="emit('delete', monitor.id)"
      >
        Delete
      </Button>
    </footer>
  </article>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-4);
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  transition: border-color 140ms ease;
}

.card:hover {
  border-color: var(--border-strong);
}

.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.status-dot {
  flex-shrink: 0;
  width: 9px;
  height: 9px;
  border-radius: 50%;
}

.dot-success {
  background-color: var(--success);
}

.dot-error {
  background-color: var(--error);
}

.dot-warning {
  background-color: var(--warning);
}

.dot-neutral {
  background-color: var(--muted);
}

.card-name {
  min-width: 0;
  overflow: hidden;
  font-size: 14.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-target {
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
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

.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
  font-size: 11px;
}

.tag-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.card-snippet {
  max-height: 110px;
  padding: var(--space-2) var(--space-3);
  overflow: auto;
  background-color: var(--error-soft);
  border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
  border-radius: var(--radius-sm);
  color: var(--error);
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-top: auto;
  padding-top: var(--space-1);
}

.card-channels {
  color: var(--muted);
  font-size: 11.5px;
}
</style>
