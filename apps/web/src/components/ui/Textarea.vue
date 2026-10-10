<script setup lang="ts">
import { computed, useId } from 'vue'
import Field from './Field.vue'

const model = defineModel<string>({ default: '' })

const props = withDefaults(
  defineProps<{
    label?: string
    hint?: string
    error?: string | null
    placeholder?: string
    rows?: number
    disabled?: boolean
    readonly?: boolean
    required?: boolean
    /** Renders the value in the monospace font (payload templates). */
    mono?: boolean
    id?: string
  }>(),
  {
    rows: 4,
    disabled: false,
    readonly: false,
    required: false,
    mono: false,
    error: null,
  },
)

const uid = useId()
const textareaId = computed(() => props.id ?? `textarea-${uid}`)
const invalid = computed(() => props.error !== null && props.error !== '')
</script>

<template>
  <Field
    :id="textareaId"
    :label="label"
    :hint="hint"
    :error="error"
    :required="required"
    v-slot="{ describedBy }"
  >
    <textarea
      :id="textareaId"
      v-model="model"
      class="control"
      :class="{ 'is-invalid': invalid, 'mono-control': mono }"
      :rows="rows"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :required="required"
      :aria-invalid="invalid ? true : undefined"
      :aria-describedby="describedBy"
    />
  </Field>
</template>
