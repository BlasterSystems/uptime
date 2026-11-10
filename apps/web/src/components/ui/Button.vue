<script setup lang="ts">
import Spinner from './Spinner.vue'

withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
    size?: 'sm' | 'md' | 'lg'
    type?: 'button' | 'submit' | 'reset'
    loading?: boolean
    disabled?: boolean
    block?: boolean
  }>(),
  {
    variant: 'secondary',
    size: 'md',
    type: 'button',
    loading: false,
    disabled: false,
    block: false,
  },
)

const emit = defineEmits<{ click: [event: MouseEvent] }>()
</script>

<template>
  <button
    :type="type"
    class="btn"
    :class="[`btn-${variant}`, `btn-${size}`, { 'btn-block': block, 'is-loading': loading }]"
    :disabled="disabled || loading"
    :aria-busy="loading ? true : undefined"
    @click="emit('click', $event)"
  >
    <Spinner v-if="loading" :size="size === 'lg' ? 'md' : 'sm'" label="" />
    <slot />
  </button>
</template>

<style scoped>
/* DS v1.1 .bs-btn: hairline secondary, ink primary, flush-left verb labels,
 * 36/44/48 min-heights, 150ms transitions. The thread is never a fill:
 * danger is an outlined vermilion action. */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  min-width: 0;
  min-height: var(--control-md);
  padding: 0 18px;
  background-color: transparent;
  border: 0;
  border-radius: var(--radius-control);
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: var(--fs-nav);
  font-weight: var(--fw-medium);
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--dur-press),
    box-shadow var(--dur-press),
    color var(--dur-press),
    opacity var(--dur-press);
}

.btn-sm {
  min-height: var(--control-sm);
  padding: 0 14px;
  font-size: var(--fs-ui);
}

.btn-md {
  min-height: var(--control-md);
}

.btn-lg {
  min-height: var(--control-lg);
  padding: 0 20px;
  font-size: var(--fs-body);
}

.btn-block {
  width: 100%;
}

.btn:hover:not(:disabled),
.btn-secondary:hover:not(:disabled) {
  box-shadow: inset 0 0 0 1px var(--ink);
  color: var(--ink);
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn-primary {
  background-color: var(--action-bg);
  box-shadow: none;
  color: var(--action-fg);
}

.btn-primary:hover:not(:disabled) {
  background-color: var(--action-bg-hover);
  box-shadow: none;
  color: var(--action-fg);
}

.btn-secondary {
  box-shadow: inset 0 0 0 1px var(--border-2);
}

.btn-danger {
  box-shadow: inset 0 0 0 1px var(--thread);
  color: var(--thread-ink);
}

.btn-danger:hover:not(:disabled) {
  background-color: var(--thread-wash);
  box-shadow: inset 0 0 0 1px var(--thread);
  color: var(--thread-ink);
}

.btn-ghost {
  box-shadow: none;
  color: var(--text-2);
}

.btn-ghost:hover:not(:disabled) {
  background-color: var(--surface-sunken);
  box-shadow: none;
  color: var(--ink);
}
</style>
