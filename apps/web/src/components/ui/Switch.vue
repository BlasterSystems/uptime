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
const switchId = computed(() => props.id ?? `switch-${uid}`)
const describedBy = computed(() =>
  props.hint === undefined ? undefined : `${switchId.value}-hint`,
)
</script>

<template>
  <div class="switch-row" :class="{ 'is-disabled': disabled }">
    <button
      :id="switchId"
      type="button"
      role="switch"
      class="switch"
      :class="{ 'is-on': model }"
      :aria-checked="model"
      :disabled="disabled"
      :aria-labelledby="label !== undefined ? `${switchId}-label` : undefined"
      :aria-describedby="describedBy"
      @click="model = !model"
    >
      <span class="switch-track" aria-hidden="true">
        <span class="switch-thumb" />
      </span>
    </button>
    <span class="switch-text">
      <label
        v-if="label !== undefined"
        class="switch-label"
        :id="`${switchId}-label`"
        :for="switchId"
      >
        {{ label }}
      </label>
      <span v-if="hint !== undefined" :id="`${switchId}-hint`" class="switch-hint">{{ hint }}</span>
    </span>
  </div>
</template>

<style scoped>
.switch-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  min-width: 0;
}

.switch-row.is-disabled {
  opacity: 0.6;
}

.switch {
  flex-shrink: 0;
  padding: 0;
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.switch:disabled {
  cursor: not-allowed;
}

.switch-track {
  display: block;
  width: 38px;
  height: 22px;
  padding: 3px;
  background-color: var(--paper-2);
  border: 1px solid var(--rule-2);
  border-radius: var(--radius-sm);
  transition:
    background-color 140ms ease,
    border-color 140ms ease;
}

.switch-thumb {
  display: block;
  width: 14px;
  height: 14px;
  background-color: var(--ink-3);
  border-radius: 1px;
  transition:
    transform 140ms ease,
    background-color 140ms ease;
}

.switch.is-on .switch-track {
  background-color: var(--accent);
  border-color: var(--accent);
}

.switch.is-on .switch-thumb {
  background-color: var(--accent-fg);
  transform: translateX(16px);
}

.switch-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.switch-label {
  color: var(--fg);
  font-size: 13px;
  cursor: pointer;
}

.switch-hint {
  color: var(--muted);
  font-size: 12px;
}
</style>
