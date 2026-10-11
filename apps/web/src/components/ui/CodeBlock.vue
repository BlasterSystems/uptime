<script setup lang="ts">
import { ref } from 'vue'
import Icon from './Icon.vue'

/**
 * Read-only snippet with an optional caption and a copy button. Content is
 * plain text (no highlighting) — keeping the bundle dependency-free.
 */
const props = defineProps<{
  code: string
  label?: string
}>()

const copied = ref(false)
let resetTimer: number | null = null

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.code)
    copied.value = true
    if (resetTimer !== null) window.clearTimeout(resetTimer)
    resetTimer = window.setTimeout(() => {
      copied.value = false
      resetTimer = null
    }, 1600)
  } catch {
    // Clipboard unavailable (permissions/insecure context) — the text stays selectable.
  }
}
</script>

<template>
  <figure class="code-block">
    <figcaption v-if="label !== undefined" class="code-label">{{ label }}</figcaption>
    <div class="code-body">
      <pre><code>{{ code }}</code></pre>
      <button
        type="button"
        class="copy-btn"
        :aria-label="copied ? 'Copied' : 'Copy to clipboard'"
        @click="copy"
      >
        <Icon :name="copied ? 'check' : 'copy'" :size="13" />
      </button>
    </div>
  </figure>
</template>

<style scoped>
.code-block {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.code-label {
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.code-body {
  position: relative;
  display: flex;
  min-width: 0;
}

pre {
  margin: 0;
  padding: var(--space-3) calc(var(--space-4) + 28px) var(--space-3) var(--space-3);
  overflow-x: auto;
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--fg);
  flex: 1;
  min-width: 0;
}

code {
  font-family: inherit;
  white-space: pre;
}

.copy-btn {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--muted);
  cursor: pointer;
}

.copy-btn:hover {
  color: var(--fg);
  border-color: var(--border-strong);
}

.copy-btn:active {
  transform: translateY(1px);
}
</style>
