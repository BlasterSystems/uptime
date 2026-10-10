<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'neutral' | 'accent' | 'success' | 'warning' | 'error'
    /** Renders a small leading dot — used for status badges. */
    dot?: boolean
    mono?: boolean
  }>(),
  { variant: 'neutral', dot: false, mono: false },
)
</script>

<template>
  <span class="badge" :class="[`badge-${variant}`, { 'badge-mono': mono }]">
    <span v-if="dot" class="badge-dot" aria-hidden="true" />
    <slot />
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 2px 8px;
  overflow: hidden;
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 550;
  letter-spacing: 0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge-mono {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0;
}

.badge-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  background-color: currentColor;
  border-radius: 50%;
}

.badge-accent {
  background-color: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  color: var(--accent);
}

.badge-success {
  background-color: var(--success-soft);
  border-color: color-mix(in srgb, var(--success) 35%, transparent);
  color: var(--success);
}

.badge-warning {
  background-color: var(--warning-soft);
  border-color: color-mix(in srgb, var(--warning) 35%, transparent);
  color: var(--warning);
}

.badge-error {
  background-color: var(--error-soft);
  border-color: color-mix(in srgb, var(--error) 35%, transparent);
  color: var(--error);
}
</style>
