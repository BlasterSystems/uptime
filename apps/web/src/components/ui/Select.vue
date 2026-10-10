<script setup lang="ts">
import { computed, useId } from 'vue'
import Field from './Field.vue'

interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

const model = defineModel<string>({ default: '' })

const props = withDefaults(
  defineProps<{
    options: readonly SelectOption[]
    label?: string
    hint?: string
    error?: string | null
    placeholder?: string
    disabled?: boolean
    required?: boolean
    id?: string
  }>(),
  { disabled: false, required: false, error: null },
)

const uid = useId()
const selectId = computed(() => props.id ?? `select-${uid}`)
const invalid = computed(() => props.error !== null && props.error !== '')
</script>

<template>
  <Field
    :id="selectId"
    :label="label"
    :hint="hint"
    :error="error"
    :required="required"
    v-slot="{ describedBy }"
  >
    <select
      :id="selectId"
      v-model="model"
      class="control"
      :class="{ 'is-invalid': invalid }"
      :disabled="disabled"
      :required="required"
      :aria-invalid="invalid ? true : undefined"
      :aria-describedby="describedBy"
    >
      <option v-if="placeholder !== undefined" value="" disabled>{{ placeholder }}</option>
      <option
        v-for="option in options"
        :key="option.value"
        :value="option.value"
        :disabled="option.disabled"
      >
        {{ option.label }}
      </option>
    </select>
  </Field>
</template>
