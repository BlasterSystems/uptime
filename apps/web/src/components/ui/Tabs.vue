<script setup lang="ts">
import { nextTick, ref, type ComponentPublicInstance } from 'vue'

interface TabItem {
  id: string
  label: string
}

const model = defineModel<string>({ required: true })

const props = defineProps<{ tabs: readonly TabItem[] }>()

const tabRefs = ref<HTMLButtonElement[]>([])

function setTabRef(el: Element | ComponentPublicInstance | null, index: number): void {
  if (el instanceof HTMLButtonElement) tabRefs.value[index] = el
}

function onKeydown(event: KeyboardEvent, index: number): void {
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (step === 0) return
  event.preventDefault()
  const nextIndex = (index + step + props.tabs.length) % props.tabs.length
  const nextTab = props.tabs[nextIndex]
  if (nextTab === undefined) return
  model.value = nextTab.id
  void nextTick(() => tabRefs.value[nextIndex]?.focus())
}
</script>

<template>
  <div class="tabs">
    <div class="tablist" role="tablist">
      <button
        v-for="(tab, index) in tabs"
        :id="`tab-${tab.id}`"
        :key="tab.id"
        :ref="(el) => setTabRef(el, index)"
        type="button"
        role="tab"
        class="tab"
        :class="{ 'is-active': model === tab.id }"
        :aria-selected="model === tab.id"
        :aria-controls="`panel-${tab.id}`"
        :tabindex="model === tab.id ? 0 : -1"
        @click="model = tab.id"
        @keydown="onKeydown($event, index)"
      >
        {{ tab.label }}
      </button>
    </div>
    <div
      class="tabpanel"
      role="tabpanel"
      :id="`panel-${model}`"
      :aria-labelledby="`tab-${model}`"
      tabindex="0"
    >
      <slot :name="`tab-${model}`" />
    </div>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.tablist {
  display: flex;
  gap: var(--space-1);
  padding: 3px;
  overflow-x: auto;
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  align-self: flex-start;
  max-width: 100%;
}

.tab {
  padding: 6px 14px;
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 13px;
  font-weight: 550;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}

.tab:hover {
  color: var(--fg);
}

.tab.is-active {
  background-color: var(--surface);
  box-shadow: var(--shadow);
  color: var(--fg);
}

.tabpanel {
  min-width: 0;
  outline: none;
}
</style>
