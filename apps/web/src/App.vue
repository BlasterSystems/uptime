<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { ApiError, deleteMonitor, fetchMonitors, type Monitor } from './api.js'
import MonitorCard from './components/MonitorCard.vue'
import MonitorForm from './components/MonitorForm.vue'

const POLL_INTERVAL_MS = 5000

const monitors = ref<Monitor[]>([])
const loadError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const loadedOnce = ref(false)
const formOpen = ref(false)

let pollTimer: ReturnType<typeof setInterval> | null = null
let refreshInFlight = false

async function refresh(): Promise<void> {
  if (refreshInFlight) return
  refreshInFlight = true
  try {
    monitors.value = await fetchMonitors()
    loadError.value = null
  } catch (error) {
    loadError.value = error instanceof ApiError ? error.message : 'Failed to load monitors'
  } finally {
    refreshInFlight = false
    loadedOnce.value = true
  }
}

async function handleCreated(): Promise<void> {
  formOpen.value = false
  actionError.value = null
  await refresh()
}

async function handleDelete(id: number): Promise<void> {
  actionError.value = null
  try {
    await deleteMonitor(id)
  } catch (error) {
    actionError.value = error instanceof ApiError ? error.message : 'Failed to delete monitor'
  }
  await refresh()
}

onMounted(() => {
  void refresh()
  pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS)
})

onUnmounted(() => {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})
</script>

<template>
  <div class="app">
    <header class="app-header">
      <h1>Uptime Monitoring</h1>
      <div class="header-actions">
        <span class="monitor-count">
          {{ monitors.length }} monitor{{ monitors.length === 1 ? '' : 's' }}
        </span>
        <button type="button" class="btn btn-primary" @click="formOpen = !formOpen">
          {{ formOpen ? 'Cancel' : 'Add monitor' }}
        </button>
      </div>
    </header>

    <p v-if="actionError ?? loadError" class="banner" role="alert">
      {{ actionError ?? loadError }}
    </p>

    <MonitorForm v-if="formOpen" @created="handleCreated" @cancel="formOpen = false" />

    <p v-if="!loadedOnce" class="empty-state">Loading monitors…</p>
    <p v-else-if="monitors.length === 0" class="empty-state">
      No monitors yet — add one to start checking.
    </p>
    <section v-else class="monitor-grid" aria-label="Monitors">
      <MonitorCard
        v-for="monitor in monitors"
        :key="monitor.id"
        :monitor="monitor"
        @delete="handleDelete"
      />
    </section>
  </div>
</template>
