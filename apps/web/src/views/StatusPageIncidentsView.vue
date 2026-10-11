<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ApiError, errorMessage, fetchPublicStatusIncidents } from '../api.js'
import type { StatusIncident } from '../api.js'
import { IMPACT_META, INCIDENT_STATUS_META, SOURCE_LABELS } from '../statusDisplay.js'
import { formatDateTime, formatDuration } from '../format.js'
import Badge from '../components/ui/Badge.vue'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import Spinner from '../components/ui/Spinner.vue'

const route = useRoute()

const slug = computed(() => String(route.params.slug ?? ''))
const incidents = ref<StatusIncident[]>([])
const loading = ref(true)
const notFound = ref(false)
const locked = ref(false)
const loadError = ref<string | null>(null)
/** Render-time clock for ongoing incidents' durations. */
const loadedAt = ref(Date.now())

function durationMs(incident: StatusIncident): number {
  const createdAt = Date.parse(incident.createdAt)
  if (Number.isNaN(createdAt)) return 0
  const end = incident.resolvedAt === null ? loadedAt.value : Date.parse(incident.resolvedAt)
  return Math.max(0, end - createdAt)
}

function durationLabel(incident: StatusIncident): string {
  const duration = formatDuration(durationMs(incident))
  return incident.resolvedAt === null ? `${duration} so far` : duration
}

let loadSeq = 0

async function load(): Promise<void> {
  const seq = ++loadSeq
  loading.value = true
  notFound.value = false
  locked.value = false
  loadError.value = null
  try {
    const loaded = await fetchPublicStatusIncidents(slug.value)
    if (seq !== loadSeq) return
    incidents.value = loaded
    loadedAt.value = Date.now()
  } catch (error) {
    if (seq !== loadSeq) return
    incidents.value = []
    if (error instanceof ApiError && error.status === 404) {
      notFound.value = true
    } else if (
      error instanceof ApiError &&
      error.status === 401 &&
      error.code === 'password_required'
    ) {
      locked.value = true
    } else {
      loadError.value = errorMessage(
        error,
        'The incident history could not be loaded. Please try again.',
      )
    }
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

onMounted(() => void load())
watch(slug, () => void load())
</script>

<template>
  <div class="archive-shell">
    <main class="archive-main">
      <header class="archive-head">
        <RouterLink class="back-link" :to="{ name: 'status-page', params: { slug } }">
          ← Back to status page
        </RouterLink>
        <h1 class="archive-title">Incident history</h1>
      </header>

      <div v-if="loading" class="archive-loading">
        <Spinner size="lg" label="Loading incidents" />
        <p>Loading incidents…</p>
      </div>

      <section v-else-if="notFound" class="panel state">
        <h2 class="state-title">Status page not found</h2>
        <p class="state-text">
          This status page does not exist or the operator has unpublished it.
        </p>
      </section>

      <section v-else-if="locked" class="panel state">
        <h2 class="state-title">Password required</h2>
        <p class="state-text">
          This status page is private. Enter the password on the status page, then open the history
          again.
        </p>
        <RouterLink class="state-link" :to="{ name: 'status-page', params: { slug } }">
          Back to status page
        </RouterLink>
      </section>

      <section v-else-if="loadError !== null" class="panel state">
        <h2 class="state-title">Incident history unavailable</h2>
        <p class="state-text">{{ loadError }}</p>
        <Button variant="primary" @click="load">Retry</Button>
      </section>

      <div v-else-if="incidents.length === 0" class="panel">
        <EmptyState
          title="No incidents yet"
          description="This status page has not published any incidents."
        />
      </div>

      <ul v-else class="incident-list">
        <li v-for="incident in incidents" :key="incident.id" class="incident">
          <div class="incident-head">
            <h2 class="incident-title">{{ incident.title }}</h2>
            <Badge :variant="INCIDENT_STATUS_META[incident.status].variant" dot>
              {{ INCIDENT_STATUS_META[incident.status].label }}
            </Badge>
          </div>
          <p class="incident-meta">
            <span>Impact: {{ IMPACT_META[incident.impact].label }}</span>
            <span>{{ SOURCE_LABELS[incident.source] }}</span>
            <span>Opened {{ formatDateTime(incident.createdAt) }}</span>
            <span v-if="incident.resolvedAt !== null">
              Resolved {{ formatDateTime(incident.resolvedAt) }}
            </span>
            <span>Duration: {{ durationLabel(incident) }}</span>
          </p>
        </li>
      </ul>
    </main>
  </div>
</template>

<style scoped>
.archive-shell {
  min-height: 100vh;
  background-color: var(--bg);
  color: var(--fg);
}

.archive-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-4) var(--space-5);
}

.archive-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.back-link {
  color: var(--muted);
  font-size: 12.5px;
  text-decoration: none;
}

.back-link:hover {
  color: var(--fg);
}

.archive-title {
  font-size: 20px;
  font-weight: 700;
}

.archive-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-7) 0;
  color: var(--muted);
  font-size: 13px;
}

.panel {
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-6) var(--space-5);
  text-align: center;
}

.state-title {
  font-size: 18px;
  font-weight: 700;
}

.state-text {
  max-width: 46ch;
  color: var(--muted);
  font-size: 13.5px;
}

.state-link {
  color: var(--accent);
  font-size: 13px;
}

.incident-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.incident {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.incident-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.incident-title {
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.incident-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px var(--space-3);
  color: var(--muted);
  font-size: 12px;
}
</style>
