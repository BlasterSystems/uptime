<script setup lang="ts">
import { computed, useId } from 'vue'
import Field from './Field.vue'

const model = defineModel<string>({ default: '' })

const props = withDefaults(
  defineProps<{
    label?: string
    hint?: string
    error?: string | null
    type?:
      | 'text'
      | 'email'
      | 'password'
      | 'number'
      | 'url'
      | 'search'
      | 'date'
      | 'datetime-local'
      | 'time'
      | 'color'
    placeholder?: string
    autocomplete?: string
    inputmode?: 'text' | 'numeric' | 'decimal' | 'email' | 'tel' | 'url' | 'search' | 'none'
    min?: number | string
    max?: number | string
    step?: number | string
    disabled?: boolean
    readonly?: boolean
    required?: boolean
    /** Renders the value in the monospace font (tokens, URLs). */
    mono?: boolean
    id?: string
  }>(),
  { type: 'text', disabled: false, readonly: false, required: false, mono: false, error: null },
)

const uid = useId()
const inputId = computed(() => props.id ?? `input-${uid}`)
const invalid = computed(() => props.error !== null && props.error !== '')
</script>

<template>
  <Field
    :id="inputId"
    :label="label"
    :hint="hint"
    :error="error"
    :required="required"
    v-slot="{ describedBy }"
  >
    <input
      :id="inputId"
      v-model="model"
      class="control"
      :class="{ 'is-invalid': invalid, 'mono-control': mono }"
      :type="type"
      :placeholder="placeholder"
      :autocomplete="autocomplete"
      :inputmode="inputmode"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      :readonly="readonly"
      :required="required"
      :aria-invalid="invalid ? true : undefined"
      :aria-describedby="describedBy"
    />
  </Field>
</template>
