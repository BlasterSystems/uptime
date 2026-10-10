<script setup lang="ts">
import Button from './Button.vue'
import Modal from './Modal.vue'

withDefaults(
  defineProps<{
    open: boolean
    title: string
    message?: string
    confirmLabel?: string
    cancelLabel?: string
    danger?: boolean
    loading?: boolean
  }>(),
  { confirmLabel: 'Confirm', cancelLabel: 'Cancel', danger: false, loading: false },
)

const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <Modal :open="open" :title="title" size="sm" @close="emit('cancel')">
    <p v-if="message !== undefined" class="confirm-message">{{ message }}</p>
    <slot />
    <template #footer>
      <Button variant="secondary" :disabled="loading" @click="emit('cancel')">
        {{ cancelLabel }}
      </Button>
      <Button :variant="danger ? 'danger' : 'primary'" :loading="loading" @click="emit('confirm')">
        {{ confirmLabel }}
      </Button>
    </template>
  </Modal>
</template>

<style scoped>
.confirm-message {
  color: var(--muted);
  font-size: 13.5px;
  overflow-wrap: anywhere;
}
</style>
