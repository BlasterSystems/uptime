<script setup lang="ts">
withDefaults(
  defineProps<{
    size?: 'sm' | 'md' | 'lg'
    /** Accessible label; empty string hides the announcement (decorative use). */
    label?: string
  }>(),
  { size: 'md', label: 'Loading' },
)
</script>

<template>
  <span class="spinner" :class="`spinner-${size}`" role="status" :aria-label="label || undefined">
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle class="spinner-track" cx="12" cy="12" r="9" fill="none" stroke-width="3" />
      <circle class="spinner-head" cx="12" cy="12" r="9" fill="none" stroke-width="3" />
    </svg>
  </span>
</template>

<style scoped>
.spinner {
  display: inline-flex;
  flex-shrink: 0;
  color: currentColor;
}

.spinner-sm {
  width: 14px;
  height: 14px;
}

.spinner-md {
  width: 18px;
  height: 18px;
}

.spinner-lg {
  width: 28px;
  height: 28px;
}

svg {
  width: 100%;
  height: 100%;
  animation: spinner-rotate 800ms linear infinite;
}

.spinner-track {
  stroke: currentColor;
  opacity: 0.2;
}

.spinner-head {
  stroke: currentColor;
  stroke-linecap: round;
  stroke-dasharray: 20 40;
}

@keyframes spinner-rotate {
  to {
    transform: rotate(360deg);
  }
}
</style>
