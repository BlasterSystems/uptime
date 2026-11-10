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
    <div class="control-box" :class="{ 'is-invalid': invalid }">
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
      <svg
        class="control-chev"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  </Field>
</template>

<style scoped>
/* DS v1.1 select: the rule lives on the wrapper so the chevron sits inside
 * the ledger line; the select itself draws no border. */
.control-box {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  border-bottom: 1px solid var(--border-2);
  transition: border-color var(--dur-press);
}

.control-box:hover {
  border-bottom-color: var(--text-2);
}

.control-box:focus-within {
  border-bottom: 1.5px solid var(--thread);
}

.control-box.is-invalid {
  border-bottom: 1.5px solid var(--thread);
}

.control-box .control {
  border-bottom: 0;
  appearance: none;
  cursor: pointer;
  padding-right: 22px;
}

.control-box .control:focus,
.control-box .control.is-invalid {
  border-bottom: 0;
  padding-bottom: 8px;
}

.control-chev {
  flex: none;
  color: var(--text-3);
}
</style>
