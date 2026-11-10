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
  left: var(--space-4);
  bottom: var(--space-4);
  z-index: 60;
  display: flex;
  flex-direction: column-reverse;
  gap: var(--space-2);
  width: min(340px, calc(100vw - var(--space-6)));
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: 14px 16px;
  background-color: var(--surface-sunken);
  border: 1px solid var(--border-2);
  border-left: 2px solid var(--text-2);
  border-radius: var(--radius-panel);
  pointer-events: auto;
  animation: toast-in var(--dur-ui) var(--ease-out);
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
  gap: 3px;
  min-width: 0;
}

.toast-title {
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-label-sm);
  font-weight: var(--fw-regular);
  letter-spacing: var(--tracking-mono);
  text-transform: uppercase;
}

.toast-message {
  color: var(--ink);
  font-size: var(--fs-ui);
  line-height: 1.4;
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
  border-radius: var(--radius-control);
  color: var(--text-2);
  cursor: pointer;
}

.toast-dismiss:hover {
  color: var(--accent-text);
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}
</style>
