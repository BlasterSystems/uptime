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
  background-color: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--fg);
  font-weight: 550;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
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
  background-color: var(--surface-hover);
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.btn-primary {
  background-color: var(--accent);
  border-color: var(--accent);
  color: var(--accent-fg);
}

.btn-primary:hover:not(:disabled) {
  background-color: color-mix(in srgb, var(--accent) 88%, var(--fg) 12%);
  border-color: color-mix(in srgb, var(--accent) 88%, var(--fg) 12%);
}

.btn-danger {
  background-color: var(--error);
  border-color: var(--error);
  color: #ffffff;
}

.btn-danger:hover:not(:disabled) {
  background-color: color-mix(in srgb, var(--error) 85%, var(--fg) 15%);
  border-color: color-mix(in srgb, var(--error) 85%, var(--fg) 15%);
}

.btn-ghost {
  background-color: transparent;
  border-color: transparent;
  color: var(--muted);
}

.btn-ghost:hover:not(:disabled) {
  background-color: var(--surface-hover);
  color: var(--fg);
}
</style>
