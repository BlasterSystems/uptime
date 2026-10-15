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
/* DS status chip: mono, uppercase, square, hairline. States are shapes first,
 * colour second — the diamond in thread wash is the only vermilion chip. */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 2px 8px;
  overflow: hidden;
  background-color: transparent;
  border: 1px solid var(--rule-2);
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge-mono {
  color: var(--ink);
}

.badge-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
}

.badge-success {
  color: var(--ink);
}

.badge-success .badge-dot {
  border: 0;
  border-radius: 0;
  background-color: currentColor;
}

.badge-warning {
  color: var(--ink-2);
}

.badge-error {
  border-color: var(--thread);
  background-color: var(--thread-wash);
  color: var(--thread-ink);
}

.badge-error .badge-dot {
  border-radius: 0;
  transform: rotate(45deg);
}

.badge-accent {
  color: var(--ink);
}

.badge-accent .badge-dot {
  border: 0;
  border-radius: 0;
  background-color: currentColor;
}
</style>
