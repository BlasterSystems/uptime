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
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-width: 0;
  background-color: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  box-shadow: inset 0 0 0 1px var(--rule-2);
  color: var(--ink);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    box-shadow 120ms ease,
    color 120ms ease,
    opacity 120ms ease;
}

.btn-sm {
  padding: 4px 9px;
  font-size: 12px;
}

.btn-md {
  padding: 7px 13px;
  font-size: 13px;
}

.btn-lg {
  padding: 10px 18px;
  font-size: 14px;
}

.btn-block {
  width: 100%;
}

.btn:hover:not(:disabled) {
  box-shadow: inset 0 0 0 1px var(--ink);
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.btn-primary {
  background-color: var(--ink);
  box-shadow: none;
  color: var(--paper);
}

.btn-primary:hover:not(:disabled) {
  background-color: var(--ink-2);
}

/* The thread is never a fill: danger is an outlined vermilion action. */
.btn-danger {
  box-shadow: inset 0 0 0 1px var(--thread);
  color: var(--thread-ink);
}

.btn-danger:hover:not(:disabled) {
  background-color: var(--thread-wash);
  box-shadow: inset 0 0 0 1px var(--thread);
}

.btn-ghost {
  box-shadow: none;
  color: var(--ink-2);
}

.btn-ghost:hover:not(:disabled) {
  background-color: var(--paper-2);
  color: var(--ink);
}
</style>
