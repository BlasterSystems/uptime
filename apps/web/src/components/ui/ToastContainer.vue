<script setup lang="ts">
import Icon from './Icon.vue'
import { dismissToast, toasts } from './toast.js'
</script>

<template>
  <Teleport to="body">
    <div class="toast-stack" aria-live="polite" aria-atomic="false">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="toast"
        :class="`toast-${toast.type}`"
        :role="toast.type === 'error' ? 'alert' : 'status'"
      >
        <div class="toast-content">
          <p class="toast-title">{{ toast.title }}</p>
          <p v-if="toast.message !== undefined" class="toast-message">{{ toast.message }}</p>
        </div>
        <button
          type="button"
          class="toast-dismiss"
          aria-label="Dismiss notification"
          @click="dismissToast(toast.id)"
        >
          <Icon name="close" :size="14" />
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  top: var(--space-4);
  right: var(--space-4);
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: min(360px, calc(100vw - var(--space-6)));
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
  background-color: var(--card);
  border: 1px solid var(--rule);
  border-left: 2px solid var(--ink-2);
  border-radius: var(--radius);
  pointer-events: auto;
  animation: toast-in 160ms ease-out;
}

.toast-success {
  border-left-color: var(--ink);
}

.toast-error {
  border-left-color: var(--thread);
}

.toast-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.toast-title {
  font-size: 13px;
  font-weight: 600;
}

.toast-message {
  color: var(--muted);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

.toast-dismiss {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  margin-left: auto;
  padding: 0;
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--muted);
  cursor: pointer;
}

.toast-dismiss:hover {
  background-color: var(--surface-hover);
  color: var(--fg);
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
}
</style>
