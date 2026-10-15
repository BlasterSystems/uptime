<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** id of the control this field labels/describes. */
    id: string
    label?: string
    hint?: string
    error?: string | null
    required?: boolean
  }>(),
  { required: false, error: null },
)

const describedBy = computed(() => {
  if (props.error !== null && props.error !== '') return `${props.id}-error`
  if (props.hint !== undefined && props.hint !== '') return `${props.id}-hint`
  return undefined
})
</script>

<template>
  <div class="field" :class="{ 'is-invalid': error !== null && error !== '' }">
    <label v-if="label !== undefined && label !== ''" class="field-label" :for="id">
      {{ label }}
      <span v-if="required" class="field-required" aria-hidden="true">*</span>
    </label>
    <slot :described-by="describedBy" :invalid="error !== null && error !== ''" />
    <p v-if="error !== null && error !== ''" :id="`${id}-error`" class="field-error" role="alert">
      {{ error }}
    </p>
    <p v-else-if="hint !== undefined && hint !== ''" :id="`${id}-hint`" class="field-hint">
      {{ hint }}
    </p>
  </div>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.field-label {
  display: flex;
  align-items: center;
  gap: 3px;
  color: var(--ink-3);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.field-required {
  color: var(--thread-ink);
}

.field-hint {
  color: var(--ink-3);
  font-size: 12px;
}

.field-error {
  color: var(--thread-ink);
  font-size: 12px;
}
</style>
