<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  fetchPublicOverview,
  type PublicOverview,
  type PublicOverviewService,
} from '../api.js'
import { formatDateTime, formatLatency } from '../format.js'
import { HEARTBEAT_META, type ToneVariant } from '../statusDisplay.js'
import Badge from '../components/ui/Badge.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import Spinner from '../components/ui/Spinner.vue'

/** The DS mark: ○ transparency — vermilion thread — ■ on record. */

const REFRESH_MS = 30_000

const BANNER_TEXT: Record<PublicOverview['overall'], string> = {
  operational: 'All systems operational',
  outage: 'Service disruption',
  maintenance: 'Maintenance in progress',
  unknown: 'Status unavailable',
}

const loading = ref(true)
const loadError = ref(false)
const overview = ref<PublicOverview | null>(null)
let timer: number | null = null

async function load(): Promise<void> {
  try {
    overview.value = await fetchPublicOverview()
    loadError.value = false
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
  timer = window.setInterval(() => void load(), REFRESH_MS)
})

onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer)
})

function displayMeta(service: PublicOverviewService): { label: string; variant: ToneVariant } {
  if (service.paused) return { label: 'Paused', variant: 'neutral' }
  if (service.inMaintenance) return { label: 'Maintenance', variant: 'warning' }
  return HEARTBEAT_META[service.status]
}

function metaLine(service: PublicOverviewService): string {
  const parts = [service.type]
  if (!service.paused && service.latencyMs !== null) parts.push(formatLatency(service.latencyMs))
  return parts.join(' · ')
}

function windowRange(startAt: string | null, endAt: string | null): string {
  const start = startAt === null ? 'now' : formatDateTime(startAt)
  const end = endAt === null ? 'until done' : ` — ${formatDateTime(endAt)}`
  return `${start}${end}`
}
</script>

<template>
  <div class="public-shell">
    <main class="public-main">
      <div v-if="loading && overview === null" class="state-note">
        <Spinner size="lg" label="Loading status" />
      </div>

      <p v-else-if="loadError && overview === null" class="state-note">
        The status page is unavailable right now. Please try again later.
      </p>

      <template v-else-if="overview !== null">
        <header class="public-head">
          <span class="brand-mark" aria-hidden="true">
            <span class="mark-node" />
            <span class="mark-line" />
            <span class="mark-square" />
          </span>
          <div class="public-heading">
            <h1 class="public-title">{{ overview.title }}</h1>
            <p class="public-caption">Service status · refreshes every 30 s</p>
          </div>
        </header>

        <div
          v-if="overview.services.length > 0"
          class="overall-banner"
          :class="`is-${overview.overall}`"
          role="status"
        >
          <span class="banner-dot" aria-hidden="true" />
          {{ BANNER_TEXT[overview.overall] }}
        </div>

        <EmptyState
          v-if="overview.services.length === 0"
          title="Nothing public yet"
          description="No services are published. Services appear here once they are flagged public in the monitor settings."
        />

        <section v-else class="panel" aria-label="Public services">
          <ul class="service-list">
            <li v-for="service in overview.services" :key="service.id" class="service-row">
              <div class="service-id">
                <p class="service-name">{{ service.name }}</p>
                <p class="service-meta mono">{{ metaLine(service) }}</p>
              </div>
              <div class="service-state">
                <p class="service-uptime mono">{{ service.uptimePct.toFixed(2) }}% · 24h</p>
                <Badge :variant="displayMeta(service).variant" dot>
                  {{ displayMeta(service).label }}
                </Badge>
              </div>
            </li>
          </ul>
        </section>

        <section
          v-if="overview.maintenance.active.length > 0 || overview.maintenance.upcoming.length > 0"
          class="panel"
          aria-label="Maintenance windows"
        >
          <p class="panel-title">Maintenance</p>
          <ul class="maintenance-list">
            <li v-for="window in overview.maintenance.active" :key="`a${window.id}`">
              <Badge variant="warning" dot>In progress</Badge>
              <span class="maintenance-name">{{ window.name }}</span>
              <span class="maintenance-time mono">{{ windowRange(window.startAt, window.endAt) }}</span>
            </li>
            <li v-for="window in overview.maintenance.upcoming" :key="`u${window.id}`">
              <Badge variant="neutral" dot>Upcoming</Badge>
              <span class="maintenance-name">{{ window.name }}</span>
              <span class="maintenance-time mono">{{ windowRange(window.startAt, window.endAt) }}</span>
            </li>
          </ul>
        </section>
      </template>
    </main>

    <footer class="public-footer">
      <p>Powered by Uptime</p>
    </footer>
  </div>
</template>

<style scoped>
.public-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background-color: var(--paper);
  color: var(--ink);
}

.public-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-4) var(--space-5);
  flex-grow: 1;
}

.state-note {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-7) 0;
  color: var(--ink-2);
  font-size: 13px;
}

/* The DS thread mark: ○ transparency — vermilion thread — ■ on record. */
.public-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-mark {
  position: relative;
  flex: none;
  width: 30px;
  height: 10px;
  color: var(--ink);
}

.mark-node {
  position: absolute;
  left: 0;
  top: 0;
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
}

.mark-line {
  position: absolute;
  left: 10px;
  right: 10px;
  top: 4.25px;
  height: 1.5px;
  background: var(--thread);
}

.mark-square {
  position: absolute;
  right: 0;
  top: 0;
  width: 10px;
  height: 10px;
  background: currentColor;
}

.public-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.public-title {
  font-size: 20px;
  font-weight: 500;
  overflow-wrap: anywhere;
}

.public-caption {
  color: var(--ink-3);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.overall-banner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid;
  border-radius: var(--radius);
  font-size: 13.5px;
  font-weight: 500;
}

.overall-banner.is-operational {
  background-color: var(--grid);
  border-color: var(--ink);
  color: var(--ink);
}

.overall-banner.is-outage {
  background-color: var(--thread-wash);
  border-color: var(--thread);
  color: var(--thread-ink);
}

.overall-banner.is-maintenance {
  background-color: var(--paper-2);
  border-color: var(--ink-2);
  color: var(--ink-2);
}

.overall-banner.is-unknown {
  background-color: var(--paper-2);
  border-color: var(--rule-2);
  color: var(--ink-2);
}

.banner-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  background-color: currentColor;
  border-radius: 0;
}

/* Shape-first: ■ operational, ◆ outage, ○ maintenance/unknown. */
.is-maintenance .banner-dot,
.is-unknown .banner-dot {
  background-color: transparent;
  border: 1.5px solid currentColor;
  border-radius: 50%;
}

.is-outage .banner-dot {
  background-color: transparent;
  border: 1.5px solid currentColor;
  transform: rotate(45deg);
}

.panel {
  background-color: var(--card);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}

.panel-title {
  padding: var(--space-3) var(--space-4) 0;
  color: var(--ink-3);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.service-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.service-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
}

.service-row + .service-row {
  border-top: 1px solid var(--rule);
}

.service-id {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.service-name {
  font-size: 14.5px;
  font-weight: 500;
  overflow-wrap: anywhere;
}

.service-meta {
  color: var(--ink-3);
  font-size: 11.5px;
}

.service-state {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex-shrink: 0;
}

.service-uptime {
  color: var(--ink-3);
  font-size: 10.5px;
}

.maintenance-list {
  margin: 0;
  padding: var(--space-2) var(--space-4) var(--space-3);
  list-style: none;
}

.maintenance-list li {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-2) 0;
  font-size: 13px;
}

.maintenance-name {
  font-weight: 500;
  overflow-wrap: anywhere;
}

.maintenance-time {
  margin-left: auto;
  color: var(--ink-3);
  font-size: 11px;
  white-space: nowrap;
}

.public-footer {
  padding: var(--space-4);
  color: var(--ink-3);
  font-size: 12px;
  text-align: center;
}

@media (max-width: 560px) {
  .service-row {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .service-state {
    flex-direction: row;
    align-items: center;
    gap: var(--space-3);
  }
}
</style>
