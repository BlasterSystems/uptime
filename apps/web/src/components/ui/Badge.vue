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
/* DS v1.1 .bs-chip: mono uppercase 11px, hairline, 2px corners. States are
 * shapes first, colour second — the held chip (error) is the only vermilion
 * one: thread border, thread wash fill, thread-ink text. */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 5px 9px;
  overflow: hidden;
  background-color: transparent;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-control);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: var(--fs-label-sm);
  font-weight: var(--fw-regular);
  letter-spacing: var(--tracking-mono);
  line-height: 1.3;
  text-transform: uppercase;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge-mono {
  color: var(--ink);
}

.badge-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
}

.badge-success {
  color: var(--ink);
}

.badge-success .badge-dot {
  border: 0;
  border-radius: 0;
  width: 7px;
  height: 7px;
  background-color: currentColor;
}

.badge-warning {
  color: var(--text-2);
}

.badge-error {
  border-color: var(--thread);
  background-color: var(--accent-wash);
  color: var(--accent-text);
}

.badge-error .badge-dot {
  border-radius: 0;
  width: 7px;
  height: 7px;
  transform: rotate(45deg);
}

.badge-accent {
  color: var(--ink);
}

.badge-accent .badge-dot {
  border: 0;
  border-radius: 0;
  width: 7px;
  height: 7px;
  background-color: currentColor;
}
</style>
