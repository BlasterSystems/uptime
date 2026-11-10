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
/* DS v1.1 .bs-tabs: sans 15px, hairline bottom edge, active tab ink + 500
 * with a 2px inset bar. */
.tabs {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.tablist {
  display: flex;
  gap: 0 24px;
  overflow-x: auto;
  align-self: flex-start;
  max-width: 100%;
  border-bottom: 1px solid var(--border-1);
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: var(--control-md);
  min-width: 40px;
  padding: 0;
  background: none;
  border: 0;
  color: var(--text-2);
  font-family: var(--font-sans);
  font-size: var(--fs-nav);
  font-weight: var(--fw-regular);
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--dur-press);
}

.tab:hover {
  color: var(--ink);
}

.tab.is-active {
  color: var(--ink);
  font-weight: var(--fw-medium);
  box-shadow: inset 0 -2px 0 var(--ink);
}

.tabpanel {
  min-width: 0;
  outline: none;
}
</style>
