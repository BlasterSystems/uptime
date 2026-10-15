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
  background-color: var(--paper-2);
  border: 1px solid var(--rule);
  border-radius: var(--radius-sm);
}

.tone-up {
  background-color: var(--ink);
  border-color: transparent;
}

.tone-down {
  background-color: var(--thread);
  border-color: transparent;
}

.tone-pending {
  background-color: var(--rule-2);
  border-color: transparent;
}

/* Maintenance is the DS "placeholder" stripe: no state colour, just hatching. */
.tone-maintenance {
  background:
    repeating-linear-gradient(135deg, var(--rule-2) 0 1px, transparent 1px 7px),
    var(--paper-2);
  border-color: var(--rule-2);
}

.strip-caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--ink-3);
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
</style>
