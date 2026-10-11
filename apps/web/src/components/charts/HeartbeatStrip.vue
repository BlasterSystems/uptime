<script setup lang="ts">
import type { StripCell } from './types.js'

/**
 * The 90-day heartbeat strip: one cell per local calendar day, oldest first.
 * Extracted from the monitor detail view so it can also render a status-page
 * component's daily rollups.
 */
withDefaults(
  defineProps<{
    cells: readonly StripCell[]
    ariaLabel?: string
    startLabel?: string
    endLabel?: string
  }>(),
  { ariaLabel: '90-day heartbeat history', startLabel: '90 days ago', endLabel: 'Today' },
)
</script>

<template>
  <div class="strip" role="img" :aria-label="ariaLabel">
    <span
      v-for="cell in cells"
      :key="cell.key"
      class="strip-cell"
      :class="`tone-${cell.tone}`"
      :title="cell.title"
    />
  </div>
  <div class="strip-caption">
    <span>{{ startLabel }}</span>
    <span>{{ endLabel }}</span>
  </div>
</template>

<style scoped>
.strip {
  display: flex;
  gap: 2px;
}

.strip-cell {
  flex: 1;
  height: 26px;
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.tone-up {
  background-color: var(--success);
  border-color: transparent;
}

.tone-down {
  background-color: var(--error);
  border-color: transparent;
}

.tone-pending {
  background-color: var(--warning);
  border-color: transparent;
}

.tone-maintenance {
  background-color: var(--muted);
  border-color: transparent;
}

.strip-caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--muted);
  font-size: 12px;
}
</style>
