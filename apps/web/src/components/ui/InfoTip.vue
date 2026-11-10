<script setup lang="ts">
/**
 * DS v1.1 InfoTip: a help affordance that reveals the worked-out calculation
 * behind a figure — text plus optional ledger rows and a total.
 */
withDefaults(
  defineProps<{
    label: string
    text: string
    rows?: readonly [string, string][]
    total?: readonly [string, string]
  }>(),
  {},
)
</script>

<template>
  <span class="tipwrap">
    <button type="button" class="tip-btn" :aria-label="label">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" />
        <path d="M12 11v5.5M12 7.6v.2" />
      </svg>
    </button>
    <span class="tip" role="tooltip">
      <span class="tip-text">{{ text }}</span>
      <span v-if="(rows !== undefined && rows.length > 0) || total !== undefined" class="tip-calc">
        <template v-if="rows !== undefined">
          <template v-for="([key, value], index) in rows" :key="index">
            <span>{{ key }}</span>
            <span>{{ value }}</span>
          </template>
        </template>
        <template v-if="total !== undefined">
          <span class="tip-total">{{ total[0] }}</span>
          <span class="tip-total">{{ total[1] }}</span>
        </template>
      </span>
    </span>
  </span>
</template>

<style scoped>
.tipwrap {
  position: relative;
  display: inline-flex;
  flex: none;
}

.tip-btn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  margin: -6px -8px -6px 0;
  padding: 0;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-3);
  cursor: help;
}

.tip-btn:hover {
  color: var(--ink);
}

.tip {
  position: absolute;
  z-index: 10;
  top: 30px;
  right: -8px;
  display: none;
  flex-direction: column;
  gap: 10px;
  width: min(300px, 80vw);
  padding: 14px 16px;
  background-color: var(--surface-tooltip);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-panel);
  text-align: left;
  animation: bs-rise var(--dur-ui) var(--ease-out);
}

.tipwrap:hover .tip,
.tip-btn:focus-visible + .tip {
  display: flex;
}

.tip-text {
  color: var(--text-2);
  font-size: 13.5px;
  line-height: 1.45;
}

.tip-calc {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px 0;
  font-family: var(--font-mono);
  font-size: var(--fs-data-sm);
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}

.tip-calc > span:nth-child(4n + 1),
.tip-calc > span:nth-child(4n + 3) {
  color: var(--text-3);
}

.tip-calc > span:nth-child(even) {
  padding-left: 12px;
  text-align: right;
}

.tip-total {
  padding-top: 7px;
  border-top: 1px solid var(--border-2);
  color: var(--ink);
}
</style>
