<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ApiError, MIN_INTERVAL_S, createMonitor } from '../api.js'

const emit = defineEmits<{ created: []; cancel: [] }>()

const form = reactive({
  name: '',
  url: '',
  intervalS: 60,
  retries: 0,
})

const error = ref<string | null>(null)
const submitting = ref(false)

function validate(): string | null {
  if (form.name.trim() === '') return 'Name is required'

  const url = form.url.trim()
  if (url === '') return 'URL is required'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'URL must be a valid absolute URL'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'URL must use the http or https scheme'
  }

  if (!Number.isInteger(form.intervalS) || form.intervalS < MIN_INTERVAL_S) {
    return `Interval must be a whole number of at least ${MIN_INTERVAL_S} seconds`
  }
  if (!Number.isInteger(form.retries) || form.retries < 0) {
    return 'Retries must be a non-negative whole number'
  }
  return null
}

async function submit(): Promise<void> {
  error.value = validate()
  if (error.value !== null) return

  submitting.value = true
  try {
    await createMonitor({
      name: form.name.trim(),
      intervalS: form.intervalS,
      retries: form.retries,
      config: { url: form.url.trim() },
    })
    emit('created')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Failed to create monitor'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <form class="monitor-form" novalidate @submit.prevent="submit">
    <div class="form-grid">
      <label class="field">
        <span class="field-label">Name</span>
        <input v-model="form.name" type="text" placeholder="My website" autocomplete="off" />
      </label>
      <label class="field">
        <span class="field-label">URL</span>
        <input v-model="form.url" type="url" placeholder="https://example.com" autocomplete="off" />
      </label>
      <label class="field">
        <span class="field-label">Interval (seconds)</span>
        <input v-model.number="form.intervalS" type="number" :min="MIN_INTERVAL_S" step="1" />
      </label>
      <label class="field">
        <span class="field-label">Retries</span>
        <input v-model.number="form.retries" type="number" min="0" step="1" />
      </label>
    </div>

    <p v-if="error" class="form-error" role="alert">{{ error }}</p>

    <div class="form-actions">
      <button type="submit" class="btn btn-primary" :disabled="submitting">
        {{ submitting ? 'Creating…' : 'Create monitor' }}
      </button>
      <button type="button" class="btn" :disabled="submitting" @click="emit('cancel')">
        Cancel
      </button>
    </div>
  </form>
</template>
