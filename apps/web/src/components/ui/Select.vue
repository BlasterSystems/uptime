<script setup lang="ts">
import { computed, useId } from 'vue'
import Field from './Field.vue'

interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

/** A labelled `<optgroup>` of options; mutually exclusive with `options`. */
interface SelectGroup {
  label: string
  options: readonly SelectOption[]
}

const model = defineModel<string>({ default: '' })

const props = withDefaults(
  defineProps<{
    options?: readonly SelectOption[]
    groups?: readonly SelectGroup[]
    label?: string
    hint?: string
    error?: string | null
    placeholder?: string
    disabled?: boolean
    required?: boolean
    id?: string
  }>(),
  { options: () => [], disabled: false, required: false, error: null },
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
      <template v-if="groups !== undefined">
        <optgroup v-for="group in groups" :key="group.label" :label="group.label">
          <option
            v-for="option in group.options"
            :key="option.value"
            :value="option.value"
            :disabled="option.disabled"
          >
            {{ option.label }}
          </option>
        </optgroup>
      </template>
      <template v-else>
        <option
          v-for="option in options"
          :key="option.value"
          :value="option.value"
          :disabled="option.disabled"
        >
          {{ option.label }}
        </option>
      </template>
    </select>
  </Field>
</template>
