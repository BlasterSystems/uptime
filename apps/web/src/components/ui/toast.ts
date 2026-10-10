/**
 * Toast store. A module-level queue keeps notifications alive across route
 * changes; `ToastContainer.vue` is the single renderer, mounted in `App.vue`.
 */
import { computed, ref, type ComputedRef } from 'vue'

export type ToastType = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  type: ToastType
  title: string
  message?: string
}

export interface ToastApi {
  toasts: ComputedRef<Toast[]>
  success: (title: string, message?: string) => number
  error: (title: string, message?: string) => number
  info: (title: string, message?: string) => number
  dismiss: (id: number) => void
}

const DURATION_MS: Record<ToastType, number> = { success: 5000, info: 6000, error: 9000 }

const items = ref<Toast[]>([])
const timers = new Map<number, number>()
let nextId = 1

export const toasts: ComputedRef<Toast[]> = computed(() => items.value)

export function dismissToast(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    timers.delete(id)
  }
  items.value = items.value.filter((toast) => toast.id !== id)
}

export function pushToast(type: ToastType, title: string, message?: string): number {
  const id = nextId++
  const toast: Toast = message === undefined ? { id, type, title } : { id, type, title, message }
  items.value = [...items.value, toast]
  timers.set(
    id,
    window.setTimeout(() => dismissToast(id), DURATION_MS[type]),
  )
  return id
}

export function useToast(): ToastApi {
  return {
    toasts,
    success: (title, message) => pushToast('success', title, message),
    error: (title, message) => pushToast('error', title, message),
    info: (title, message) => pushToast('info', title, message),
    dismiss: dismissToast,
  }
}
