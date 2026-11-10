<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import type { HeartbeatStatus, Monitor } from '../api.js'
import { formatDateTime, formatLatency, relativeTime } from '../format.js'
import { MONITOR_TYPE_LABELS, monitorTarget } from '../monitorDisplay.js'
import Badge from './ui/Badge.vue'
import Button from './ui/Button.vue'

const props = withDefaults(
  defineProps<{ monitor: Monitor; /** Brief thread-wash flash when a beat just arrived. */ fresh?: boolean }>(),
  { fresh: false },
)
const emit = defineEmits<{ delete: [id: number]; open: [id: number] }>()

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

const heartbeat = computed(() => props.monitor.latestHeartbeat)

/** A down beat's elapsed time is failure evidence, not a latency sample. */
const cardLatency = computed(() =>
  heartbeat.value?.status === 'down' ? null : heartbeat.value?.latencyMs ?? null,
)

const lastCheck = computed(() => {
  const time = heartbeat.value?.time
  if (time === undefined) return null
  // A last check cannot sit in the future — clamp clock-skewed SSE beats.
  const timestamp = Date.parse(time)
  return relativeTime(time, Number.isNaN(timestamp) ? Date.now() : Math.max(Date.now(), timestamp))
})

const lastCheckExact = computed(() => {
  const time = heartbeat.value?.time
  return time === undefined ? undefined : formatDateTime(time)
})

const failureSnippet = computed(() =>
  heartbeat.value?.status === 'down' ? heartbeat.value.responseSnippet : null,
)

/** Non-http targets get their type prefixed so the row reads unambiguously. */
const targetText = computed(() => {
  const target = monitorTarget(props.monitor)
  return props.monitor.type === 'http' ? target : `${MONITOR_TYPE_LABELS[props.monitor.type]} · ${target}`
})

/** Shape-first state glyph: ■ up, ◆ down, ○ pending/maintenance. */
const glyphClass = computed(() => {
  switch (status.value.variant) {
    case 'success':
      return 'glyph--recorded tone-ink'
    case 'error':
      return 'glyph--decision tone-thread'
    case 'warning':
      return 'glyph--estimated tone-muted'
    default:
      return 'glyph--estimated tone-faint'
  }
})
</script>

<template>
  <article class="row" :class="{ 'row-new': fresh }" @click="emit('open', monitor.id)">
    <span class="glyph" :class="glyphClass" aria-hidden="true"></span>

    <div class="row-main">
      <span class="row-name" :title="monitor.name">
        <RouterLink
          class="row-link"
          :to="{ name: 'monitor-detail', params: { id: monitor.id } }"
          @click.stop
        >
          {{ monitor.name }}
        </RouterLink>
      </span>
      <span class="row-target" :title="monitorTarget(monitor)">{{ targetText }}</span>
      <pre v-if="failureSnippet !== null" class="row-snippet">{{ failureSnippet }}</pre>
    </div>

    <div class="row-lat">
      <span class="lat-value">{{ formatLatency(cardLatency) }}</span>
      <span v-if="lastCheck !== null" class="lat-check" :title="lastCheckExact">{{ lastCheck }}</span>
      <span v-else class="lat-check">No heartbeats yet</span>
    </div>

    <div class="row-chips">
      <Badge :variant="status.variant" dot>{{ status.label }}</Badge>
      <Badge v-if="monitor.isPublic" variant="accent">public</Badge>
      <Badge v-if="!monitor.active" variant="warning">paused</Badge>
    </div>

    <div class="row-actions">
      <Button
        variant="ghost"
        size="sm"
        :aria-label="`Delete monitor ${monitor.name}`"
        @click.stop="emit('delete', monitor.id)"
      >
        Delete
      </Button>
    </div>
  </article>
</template>

<style scoped>
/* DS v1.1 data row: hairline-separated, glyph + name/target + tabular figure
 * + chips. Replaces the boxed monitor card. */
.row {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) auto auto auto;
  gap: 12px;
  align-items: center;
  padding: 11px 2px;
  border-top: 1px solid var(--border-1);
  cursor: pointer;
  transition: background-color var(--dur-press);
}

.row:hover {
  background-color: var(--grid);
}

.row-new {
  animation: bs-wash 900ms var(--ease-out);
}

.tone-ink {
  color: var(--ink);
}

.tone-thread {
  color: var(--thread);
}

.tone-muted {
  color: var(--text-2);
}

.tone-faint {
  color: var(--text-3);
}

.row-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.row-name {
  overflow: hidden;
  font-size: var(--fs-nav);
  font-weight: var(--fw-medium);
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-link {
  color: inherit;
  text-decoration: none;
}

.row-link:hover {
  color: var(--accent-text);
}

.row-target {
  overflow: hidden;
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-data-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-snippet {
  max-height: 110px;
  margin: 4px 0 0;
  padding: 6px 10px;
  overflow: auto;
  background-color: var(--accent-wash);
  border-left: 2px solid var(--thread);
  border-radius: var(--radius-control);
  color: var(--accent-text);
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.row-lat {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
}

.lat-value {
  font-size: var(--fs-data);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.lat-check {
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-label-sm);
  white-space: nowrap;
}

.row-chips {
  display: flex;
  align-items: center;
  gap: 6px;
}

.row-actions {
  display: flex;
  justify-content: flex-end;
}

@media (max-width: 720px) {
  .row {
    grid-template-columns: 14px minmax(0, 1fr) auto;
    row-gap: 6px;
  }

  .row-lat {
    grid-column: 2;
    align-items: flex-start;
  }

  .row-chips {
    grid-column: 3;
    grid-row: 1;
  }

  .row-actions {
    grid-column: 3;
    grid-row: 2;
  }
}
</style>
