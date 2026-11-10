<script setup lang="ts">
import { computed, useId } from 'vue'

const model = defineModel<boolean>({ default: false })

const props = withDefaults(
  defineProps<{
    label?: string
    hint?: string
    disabled?: boolean
    id?: string
  }>(),
  { disabled: false },
)

const uid = useId()
const checkId = computed(() => props.id ?? `switch-${uid}`)
const describedBy = computed(() =>
  props.hint === undefined ? undefined : `${checkId.value}-hint`,
)
</script>

<template>
  <!-- DS v1.1 .bs-check row. The file keeps its name and API; the control is
   * a checkbox (the kit has no switch), 44px hit row, ink fill when on. -->
  <label :id="checkId" class="check" :class="{ 'is-disabled': disabled }">
    <input
      v-model="model"
      type="checkbox"
      class="check-input"
      :disabled="disabled"
      :aria-labelledby="checkId"
      :aria-describedby="describedBy"
    />
    <span class="check-box" aria-hidden="true"></span>
    <span class="check-text">
      <span v-if="label !== undefined" class="check-label">{{ label }}</span>
      <span v-if="hint !== undefined" :id="`${checkId}-hint`" class="check-hint">{{ hint }}</span>
    </span>
  </label>
</template>

<style scoped>
.check {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: var(--hit-min);
  padding: 8px 0;
  color: var(--ink);
  font-size: var(--fs-nav);
  cursor: pointer;
}

.check.is-disabled {
  color: var(--text-3);
  cursor: not-allowed;
}

.check-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.check-box {
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 3px;
  box-shadow: inset 0 0 0 1.5px var(--border-2);
  transition: box-shadow var(--dur-press);
}

.check:hover .check-box {
  box-shadow: inset 0 0 0 1.5px var(--text-2);
}

.check-input:checked + .check-box {
  background-color: var(--ink);
  box-shadow: none;
}

.check.is-disabled .check-box {
  opacity: 0.5;
}

.check-input:focus-visible + .check-box {
  outline: 2px solid var(--thread);
  outline-offset: 3px;
}

.check-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.check-label {
  line-height: var(--lh-ui);
}

.check-hint {
  color: var(--text-2);
  font-size: var(--fs-small);
  line-height: 1.4;
}
</style>
