<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import Icon from './Icon.vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    size?: 'sm' | 'md' | 'lg'
    closeOnBackdrop?: boolean
  }>(),
  { size: 'md', closeOnBackdrop: true },
)

const emit = defineEmits<{ close: [] }>()

const uid = useId()
const titleId = `modal-title-${uid}`
const panel = ref<HTMLElement | null>(null)
let restoreFocusTo: HTMLElement | null = null

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(): HTMLElement[] {
  if (panel.value === null) return []
  return Array.from(panel.value.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

/** Keeps Tab inside the dialog and closes it on Escape. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key !== 'Tab') return

  const items = focusables()
  if (items.length === 0) {
    event.preventDefault()
    panel.value?.focus()
    return
  }
  const first = items[0] as HTMLElement
  const last = items[items.length - 1] as HTMLElement
  const active = document.activeElement
  if (event.shiftKey && (active === first || active === panel.value)) {
    event.preventDefault()
    last.focus()
    return
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

function activate(): void {
  document.addEventListener('keydown', onKeydown, true)
  document.body.style.overflow = 'hidden'
  void nextTick(() => {
    const [first] = focusables()
    ;(first ?? panel.value)?.focus()
  })
}

function deactivate(): void {
  document.removeEventListener('keydown', onKeydown, true)
  document.body.style.overflow = ''
  if (restoreFocusTo !== null && restoreFocusTo.isConnected) restoreFocusTo.focus()
  restoreFocusTo = null
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      deactivate()
      return
    }
    restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    activate()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @mousedown.self="closeOnBackdrop && emit('close')">
      <div
        ref="panel"
        class="modal-panel"
        :class="`modal-${size}`"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="title === undefined ? undefined : titleId"
        tabindex="-1"
      >
        <header class="modal-head">
          <h2 v-if="title !== undefined" :id="titleId" class="modal-title">{{ title }}</h2>
          <button
            type="button"
            class="modal-close"
            aria-label="Close dialog"
            @click="emit('close')"
          >
            <Icon name="close" :size="16" />
          </button>
        </header>
        <div class="modal-body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="modal-foot">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: var(--space-6) var(--space-4);
  overflow-y: auto;
  background-color: var(--overlay);
  animation: backdrop-in 120ms ease-out;
}

.modal-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-height: calc(100vh - var(--space-7));
  margin: auto 0;
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  animation: panel-in 140ms ease-out;
}

.modal-sm {
  max-width: 420px;
}

.modal-md {
  max-width: 560px;
}

.modal-lg {
  max-width: 720px;
}

.modal-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-4) 0;
}

.modal-title {
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
}

.modal-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-left: auto;
  padding: 0;
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--muted);
  cursor: pointer;
}

.modal-close:hover {
  background-color: var(--surface-hover);
  color: var(--fg);
}

.modal-body {
  min-width: 0;
  padding: var(--space-4);
  overflow-y: auto;
}

.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: 0 var(--space-4) var(--space-4);
}

@keyframes backdrop-in {
  from {
    opacity: 0;
  }
}

@keyframes panel-in {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
}

@media (max-width: 560px) {
  .modal-backdrop {
    padding: var(--space-4) var(--space-2);
  }
}
</style>
