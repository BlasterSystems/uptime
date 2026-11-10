<script setup lang="ts">
import Mark from './Mark.vue'
import InfoTip from './InfoTip.vue'

/**
 * DS v1.1 StatCard: mono label, info explanation, big tabular figure,
 * optional held chip, one sentence and a basis mark.
 */
withDefaults(
  defineProps<{
    label: string
    value: string
    sub?: string
    chip?: string
    basis?: 'recorded' | 'estimated' | 'decision'
    basisLabel?: string
    explain?: { text: string; rows?: readonly [string, string][]; total?: readonly [string, string] }
  }>(),
  { basis: 'recorded' },
)
</script>

<template>
  <div class="stat">
    <div class="stat-head">
      <span class="stat-label">{{ label }}</span>
      <InfoTip
        v-if="explain !== undefined"
        :label="`How ${label.toLowerCase()} is worked out`"
        :text="explain.text"
        :rows="explain.rows"
        :total="explain.total"
      />
    </div>
    <span class="stat-figure">{{ value }}</span>
    <span v-if="chip !== undefined" class="stat-chip">
      <span class="glyph glyph--decision" aria-hidden="true"></span>
      {{ chip }}
    </span>
    <span v-if="sub !== undefined" class="stat-sub">{{ sub }}</span>
    <Mark v-if="basisLabel !== undefined" :kind="basis" class="stat-basis">{{ basisLabel }}</Mark>
  </div>
</template>

<style scoped>
.stat {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: var(--panel-pad);
  background-color: var(--surface-card);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-panel);
}

.stat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 24px;
}

.stat-label {
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-label);
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
}

.stat-figure {
  font-size: var(--fs-figure);
  font-weight: var(--fw-regular);
  letter-spacing: -0.02em;
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
}

.stat-chip {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 9px;
  border: 1px solid var(--thread);
  border-radius: var(--radius-control);
  background-color: var(--accent-wash);
  color: var(--accent-text);
  font-family: var(--font-mono);
  font-size: var(--fs-label-sm);
  letter-spacing: var(--tracking-mono);
  line-height: 1.3;
  text-transform: uppercase;
  white-space: nowrap;
}

.stat-chip .glyph {
  color: var(--thread);
}

.stat-sub {
  color: var(--text-2);
  font-size: var(--fs-ui);
  line-height: 1.45;
  text-wrap: pretty;
}

.stat-basis {
  margin-top: auto;
}
</style>
