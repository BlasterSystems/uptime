<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ApiError, errorMessage, fetchPublicStatus, unlockStatusPage } from '../api.js'
import type {
  PublicStatusComponent,
  PublicStatusDaily,
  PublicStatusPage,
  PublicStatusSeriesPoint,
  StatusIncident,
} from '../api.js'
import {
  HEARTBEAT_META,
  IMPACT_META,
  INCIDENT_STATUS_META,
  SEVERITY_META,
} from '../statusDisplay.js'
import { formatDateTime, formatLatency, relativeTime } from '../format.js'
import HeartbeatStrip from '../components/charts/HeartbeatStrip.vue'
import ResponseChart from '../components/charts/ResponseChart.vue'
import type { ChartMarker, LatencyPoint, StripCell, StripTone } from '../components/charts/types.js'
import Badge from '../components/ui/Badge.vue'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import Input from '../components/ui/Input.vue'
import Spinner from '../components/ui/Spinner.vue'

const DARK_ACCENT_FG = '#06111f'
const WHITE = '#ffffff'
/** #06111f as channels — used for the contrast check against a custom accent. */
const DARK_ACCENT_RGB: [number, number, number] = [6, 17, 31]
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/** Cadence of the "N ago" labels. */
const CLOCK_MS = 30_000

const route = useRoute()

const slug = computed(() => String(route.params.slug ?? ''))
const page = ref<PublicStatusPage | null>(null)
const loading = ref(true)
const notFound = ref(false)
const locked = ref(false)
const loadError = ref<string | null>(null)
const unlockPassword = ref('')
const unlockError = ref<string | null>(null)
const unlocking = ref(false)
const now = ref(Date.now())

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const systemDark = ref(darkQuery.matches)

function onSystemThemeChange(event: MediaQueryListEvent): void {
  systemDark.value = event.matches
}

/** An explicit `theme.dark` wins; `auto`/absent follows the OS preference live. */
const effectiveTheme = computed<'light' | 'dark'>(() => {
  const preference = page.value?.theme?.dark
  if (preference === 'light' || preference === 'dark') return preference
  return systemDark.value ? 'dark' : 'light'
})

function parseHexColor(color: string): [number, number, number] | null {
  if (!HEX_COLOR.test(color)) return null
  const hex = color.slice(1)
  const full = hex.length === 3 ? hex.replace(/./g, (char) => char + char) : hex
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

function channelLuminance(channel: number): number {
  const value = channel / 255
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  return (
    0.2126 * channelLuminance(red) +
    0.7152 * channelLuminance(green) +
    0.0722 * channelLuminance(blue)
  )
}

function contrastRatio(first: number, second: number): number {
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Dark text on light accents, white on dark ones; null when the color is not hex. */
function accentForeground(color: string): string | null {
  const rgb = parseHexColor(color)
  if (rgb === null) return null
  const luminance = relativeLuminance(rgb)
  const darkContrast = contrastRatio(luminance, relativeLuminance(DARK_ACCENT_RGB))
  const lightContrast = contrastRatio(luminance, 1)
  return darkContrast >= lightContrast ? DARK_ACCENT_FG : WHITE
}

const shellStyle = computed<CSSProperties>(() => {
  const accent = page.value?.theme?.accent?.trim()
  if (accent === undefined || accent === '' || !CSS.supports('color', accent)) return {}
  const style: CSSProperties = { '--accent': accent }
  const foreground = accentForeground(accent)
  if (foreground !== null) style['--accent-fg'] = foreground
  return style
})

function formatUptime(uptimePct: number): string {
  return uptimePct === 100 ? '100%' : `${uptimePct.toFixed(2)}%`
}

const mark = computed(() => {
  const title = page.value?.title.trim() ?? ''
  return title === '' ? 'U' : title.charAt(0).toUpperCase()
})

/** Groups that contain at least one component; empty groups are not rendered. */
const visibleGroups = computed(
  () => page.value?.groups.filter((group) => group.components.length > 0) ?? [],
)

const hasComponents = computed(() => visibleGroups.value.length > 0)

const maintenanceWindows = computed(() => {
  const maintenance = page.value?.maintenance
  if (maintenance === undefined) return []
  return maintenance.active.length + maintenance.upcoming.length
})

const componentLabels = computed<Map<string, string>>(() => {
  const labels = new Map<string, string>()
  for (const group of page.value?.groups ?? []) {
    for (const component of group.components) labels.set(component.id, component.label)
  }
  return labels
})

/** Component labels an incident is attached to, or null when it has none. */
function componentSummary(incident: StatusIncident): string | null {
  const labels = incident.componentIds
    .map((id) => componentLabels.value.get(id))
    .filter((label): label is string => label !== undefined)
  return labels.length === 0 ? null : labels.join(', ')
}

function parseDay(date: string): Date {
  return new Date(`${date}T00:00:00`)
}

function dayTitle(day: PublicStatusDaily): string {
  const label = parseDay(day.date).toLocaleDateString(undefined, { dateStyle: 'medium' })
  if (day.total === 0) return `${label} — no data`
  const parts = [`${formatUptime(day.uptimePct)} uptime`]
  if (day.down > 0) parts.push(`${day.down} down`)
  if (day.maintenance > 0) parts.push(`${day.maintenance} maintenance`)
  parts.push(`${day.total} checks`)
  return `${label} — ${parts.join(', ')}`
}

function dayTone(day: PublicStatusDaily): StripTone {
  if (day.total === 0) return 'empty'
  if (day.down > 0) return 'down'
  if (day.maintenance > 0 && day.maintenance === day.total) return 'maintenance'
  if (day.uptimePct < 100) return 'down'
  return 'up'
}

function stripCells(component: PublicStatusComponent): StripCell[] {
  return component.daily.map((day) => ({
    key: day.date,
    tone: dayTone(day),
    title: dayTitle(day),
  }))
}

function seriesOf(component: PublicStatusComponent): readonly PublicStatusSeriesPoint[] {
  return component.series ?? []
}

function chartPoints(component: PublicStatusComponent): LatencyPoint[] {
  const points: LatencyPoint[] = []
  for (const point of seriesOf(component)) {
    const time = Date.parse(point.t)
    if (Number.isNaN(time) || point.latencyMs === null) continue
    points.push({ time, latencyMs: point.latencyMs })
  }
  return points
}

function chartMarkers(component: PublicStatusComponent): ChartMarker[] {
  const markers: ChartMarker[] = []
  for (const point of seriesOf(component)) {
    const time = Date.parse(point.t)
    if (Number.isNaN(time) || point.latencyMs !== null) continue
    markers.push({ time, status: 'down', title: `${formatDateTime(point.t)} — down` })
  }
  return markers
}

let loadSeq = 0
let clockTimer: number | null = null

async function load(): Promise<void> {
  const seq = ++loadSeq
  loading.value = true
  notFound.value = false
  loadError.value = null
  try {
    const loaded = await fetchPublicStatus(slug.value)
    if (seq !== loadSeq) return
    page.value = loaded
    locked.value = false
    document.title = `${loaded.title} · Status`
  } catch (error) {
    if (seq !== loadSeq) return
    page.value = null
    if (error instanceof ApiError && error.status === 404) {
      notFound.value = true
    } else if (
      error instanceof ApiError &&
      error.status === 401 &&
      error.code === 'password_required'
    ) {
      locked.value = true
      document.title = 'Status'
    } else {
      loadError.value = errorMessage(
        error,
        'The status page could not be loaded. Please try again.',
      )
    }
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

async function unlock(): Promise<void> {
  if (unlocking.value) return
  unlocking.value = true
  unlockError.value = null
  try {
    await unlockStatusPage(slug.value, unlockPassword.value)
    unlockPassword.value = ''
    locked.value = false
    await load()
  } catch (error) {
    unlockError.value =
      error instanceof ApiError && error.status === 401
        ? 'Incorrect password. Try again.'
        : errorMessage(error, 'Could not unlock the page.')
  } finally {
    unlocking.value = false
  }
}

onMounted(() => {
  darkQuery.addEventListener('change', onSystemThemeChange)
  clockTimer = window.setInterval(() => {
    now.value = Date.now()
  }, CLOCK_MS)
  void load()
})

onUnmounted(() => {
  darkQuery.removeEventListener('change', onSystemThemeChange)
  if (clockTimer !== null) {
    window.clearInterval(clockTimer)
    clockTimer = null
  }
})

watch(slug, () => {
  locked.value = false
  unlockPassword.value = ''
  unlockError.value = null
  void load()
})
</script>

<template>
  <div class="status-shell" :data-theme="effectiveTheme" :style="shellStyle">
    <main class="status-main">
      <div v-if="loading" class="status-loading">
        <Spinner size="lg" label="Loading status page" />
        <p>Loading status…</p>
      </div>

      <section v-else-if="notFound" class="panel state" aria-labelledby="status-not-found-title">
        <h1 id="status-not-found-title" class="state-title">Status page not found</h1>
        <p class="state-text">
          This status page does not exist or the operator has unpublished it.
        </p>
      </section>

      <section v-else-if="locked" class="panel state" aria-labelledby="status-locked-title">
        <h1 id="status-locked-title" class="state-title">Password required</h1>
        <p class="state-text">This status page is private. Enter the password to view it.</p>
        <form class="unlock-form" novalidate @submit.prevent="unlock">
          <Input
            v-model="unlockPassword"
            label="Password"
            type="password"
            autocomplete="current-password"
            :error="unlockError"
          />
          <Button
            type="submit"
            variant="primary"
            :loading="unlocking"
            :disabled="unlockPassword === ''"
          >
            Unlock
          </Button>
        </form>
      </section>

      <section
        v-else-if="loadError !== null"
        class="panel state"
        aria-labelledby="status-error-title"
      >
        <h1 id="status-error-title" class="state-title">Status page unavailable</h1>
        <p class="state-text">{{ loadError }}</p>
        <Button variant="primary" @click="load">Retry</Button>
      </section>

      <template v-else-if="page !== null">
        <header class="status-header">
          <img v-if="page.logo !== null" class="status-logo" :src="page.logo" alt="" />
          <span v-else class="status-mark" aria-hidden="true">{{ mark }}</span>
          <div class="status-heading">
            <h1 class="status-title">{{ page.title }}</h1>
            <span class="status-caption">Status</span>
          </div>
        </header>

        <div class="overall-banner" :class="`is-${page.overall}`" role="status">
          <span class="banner-dot" aria-hidden="true" />
          <span>{{ SEVERITY_META[page.overall].banner }}</span>
        </div>

        <div v-if="!hasComponents" class="panel">
          <EmptyState
            title="No components on this page"
            description="The operator has not published any components yet."
          />
        </div>

        <section
          v-for="group in visibleGroups"
          :key="group.name"
          class="group"
          :aria-label="group.name"
        >
          <h2 v-if="group.name !== ''" class="group-title">{{ group.name }}</h2>
          <div class="component-list">
            <article v-for="component in group.components" :key="component.id" class="component">
              <header class="component-head">
                <div class="component-identity">
                  <h3 class="component-label">{{ component.label }}</h3>
                  <p v-if="component.description !== null" class="component-description">
                    {{ component.description }}
                  </p>
                </div>
                <Badge :variant="SEVERITY_META[component.status].variant" dot>
                  {{ SEVERITY_META[component.status].label }}
                </Badge>
              </header>

              <ul v-if="component.monitors.length > 0" class="monitor-chips" aria-label="Monitors">
                <li v-for="monitor in component.monitors" :key="monitor.id" class="monitor-chip">
                  <span class="chip-dot" :class="`is-${monitor.status}`" aria-hidden="true" />
                  <span class="chip-name">{{ monitor.name }}</span>
                  <Badge :variant="HEARTBEAT_META[monitor.status].variant">
                    {{ HEARTBEAT_META[monitor.status].label }}
                  </Badge>
                  <span class="chip-metric">{{ formatLatency(monitor.latencyMs) }}</span>
                  <span v-if="monitor.type === 'push'" class="chip-metric">
                    {{
                      monitor.lastBeatAt === null
                        ? 'no signal yet'
                        : `last signal ${relativeTime(monitor.lastBeatAt, now)}`
                    }}
                  </span>
                </li>
              </ul>

              <div v-if="component.showUptime" class="component-uptime">
                <div class="uptime-head">
                  <span class="block-caption">Uptime · 90 days</span>
                  <strong class="uptime-value">{{ formatUptime(component.uptimePct) }}</strong>
                </div>
                <HeartbeatStrip
                  :cells="stripCells(component)"
                  :aria-label="`90-day uptime for ${component.label}`"
                />
              </div>

              <div v-if="component.showChart" class="component-chart">
                <span class="block-caption">Response time · 24 h</span>
                <template v-if="seriesOf(component).length > 0">
                  <ResponseChart
                    :points="chartPoints(component)"
                    :markers="chartMarkers(component)"
                    :aria-label="`Response time over the last 24 hours for ${component.label}`"
                  />
                </template>
                <p v-else class="chart-empty">No data in the last 24 h.</p>
              </div>
            </article>
          </div>
        </section>

        <section
          v-if="page.incidents.length > 0"
          class="incidents"
          aria-labelledby="open-incidents-title"
        >
          <h2 id="open-incidents-title" class="section-heading">Active incidents</h2>
          <ul class="incident-list">
            <li v-for="incident in page.incidents" :key="incident.id" class="incident">
              <div class="incident-head">
                <h3 class="incident-title">{{ incident.title }}</h3>
                <Badge :variant="INCIDENT_STATUS_META[incident.status].variant" dot>
                  {{ INCIDENT_STATUS_META[incident.status].label }}
                </Badge>
              </div>
              <p class="incident-meta">
                <span>Impact: {{ IMPACT_META[incident.impact].label }}</span>
                <span v-if="componentSummary(incident) !== null">
                  {{ componentSummary(incident) }}
                </span>
                <span>Opened {{ formatDateTime(incident.createdAt) }}</span>
                <span>{{ relativeTime(incident.createdAt, now) }}</span>
              </p>
              <ol v-if="incident.updates.length > 0" class="timeline">
                <li v-for="update in incident.updates" :key="update.id" class="timeline-entry">
                  <div class="timeline-head">
                    <span class="timeline-status">
                      {{ INCIDENT_STATUS_META[update.status].label }}
                    </span>
                    <span class="timeline-time">{{ formatDateTime(update.createdAt) }}</span>
                  </div>
                  <p class="timeline-body">{{ update.body }}</p>
                </li>
              </ol>
            </li>
          </ul>
        </section>

        <section
          v-if="maintenanceWindows > 0"
          class="maintenance"
          aria-labelledby="maintenance-title"
        >
          <h2 id="maintenance-title" class="section-heading">Scheduled maintenance</h2>
          <ul class="maintenance-list">
            <li v-for="window in page.maintenance.active" :key="window.id" class="maintenance-item">
              <Badge variant="warning" dot>In progress</Badge>
              <span class="maintenance-name">{{ window.name }}</span>
              <span class="maintenance-time">
                <template v-if="window.startAt !== null">
                  since {{ formatDateTime(window.startAt) }}
                </template>
                <template v-if="window.endAt !== null">
                  · until {{ formatDateTime(window.endAt) }}
                </template>
              </span>
            </li>
            <li
              v-for="window in page.maintenance.upcoming"
              :key="window.id"
              class="maintenance-item"
            >
              <Badge variant="neutral" dot>Upcoming</Badge>
              <span class="maintenance-name">{{ window.name }}</span>
              <span class="maintenance-time">
                <template v-if="window.startAt !== null">
                  starts {{ formatDateTime(window.startAt) }}
                </template>
                <template v-else>no start time announced</template>
              </span>
            </li>
          </ul>
        </section>

        <footer class="status-footer">
          <p v-if="page.footerText !== null" class="footer-text">{{ page.footerText }}</p>
          <p class="footer-line">
            <RouterLink :to="{ name: 'status-incidents', params: { slug } }">
              Incident history
            </RouterLink>
            <span aria-hidden="true">·</span>
            <a :href="`/status/${slug}/rss.xml`" title="Incident feed (RSS)">RSS</a>
            <span aria-hidden="true">·</span>
            <a :href="`/status/${slug}/atom.xml`" title="Incident feed (Atom)">Atom</a>
            <span aria-hidden="true">·</span>
            <span>Powered by Uptime</span>
          </p>
        </footer>
      </template>
    </main>
  </div>
</template>

<style scoped>
/*
 * This page renders outside the app layout, so the shell re-declares the
 * palette: `src/style.css` dark tokens live on `:root` and the page's own
 * light/dark preference must win regardless of the app-level theme.
 */
.status-shell {
  --accent-soft: color-mix(in srgb, var(--accent) 14%, transparent);

  min-height: 100vh;
  background-color: var(--bg);
  color: var(--fg);
}

/* This page renders outside the app layout, so the shell re-declares the
 * BlasterSystems palette: `src/style.css` tokens live on `:root` and the
 * page's own light/dark preference must win regardless of the app theme.
 * `--accent`/`--accent-fg` default to the thread; a page-level accent colour
 * (set inline via `shellStyle`) overrides both. */
.status-shell[data-theme='light'] {
  color-scheme: light;

  --paper: #f2f4f6;
  --paper-2: #e8ebee;
  --card: #fbfcfd;
  --ink: #22272d;
  --ink-2: #4d5258;
  --ink-3: #6a6e75;
  --rule: #d4d7da;
  --rule-2: #b8bbc0;
  --thread: #dc4f37;
  --thread-ink: #be3827;
  --thread-wash: rgb(220 79 55 / 0.12);
  --grid: rgb(34 39 45 / 0.05);

  --bg: var(--paper);
  --surface: var(--card);
  --surface-2: var(--paper-2);
  --surface-hover: var(--paper-2);
  --border: var(--rule);
  --border-strong: var(--rule-2);
  --fg: var(--ink);
  --muted: var(--ink-2);
  --accent: var(--thread-ink);
  --accent-fg: #ffffff;
  --success: var(--ink);
  --success-soft: var(--grid);
  --warning: var(--ink-2);
  --warning-soft: var(--paper-2);
  --error: var(--thread);
  --error-soft: var(--thread-wash);
  --overlay: rgb(34 39 45 / 0.45);
}

.status-shell[data-theme='dark'] {
  color-scheme: dark;

  --paper: #1b1e23;
  --paper-2: #21252a;
  --card: #23282e;
  --ink: #edeff2;
  --ink-2: #bec2c6;
  --ink-3: #94989e;
  --rule: #373b41;
  --rule-2: #4d5258;
  --thread: #ef7253;
  --thread-ink: #fa8c6a;
  --thread-wash: rgb(239 114 83 / 0.16);
  --grid: rgb(237 239 242 / 0.05);

  --bg: var(--paper);
  --surface: var(--card);
  --surface-2: var(--paper-2);
  --surface-hover: var(--paper-2);
  --border: var(--rule);
  --border-strong: var(--rule-2);
  --fg: var(--ink);
  --muted: var(--ink-2);
  --accent: var(--thread-ink);
  --accent-fg: #1b1e23;
  --success: var(--ink);
  --success-soft: var(--grid);
  --warning: var(--ink-2);
  --warning-soft: var(--paper-2);
  --error: var(--thread);
  --error-soft: var(--thread-wash);
  --overlay: rgb(5 7 10 / 0.62);
}

.status-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-4) var(--space-5);
}

.status-loading {
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
  font-weight: 500;
}

.state-text {
  max-width: 46ch;
  color: var(--muted);
  font-size: 13.5px;
}

.unlock-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: 100%;
  max-width: 320px;
  text-align: left;
}

.status-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.status-logo {
  display: block;
  width: auto;
  max-width: 180px;
  height: 28px;
  object-fit: contain;
}

.status-mark {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  background-color: var(--accent);
  border-radius: var(--radius-sm);
  color: var(--accent-fg);
  font-size: 14px;
  font-weight: 500;
}

.status-heading {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.status-title {
  font-size: 20px;
  font-weight: 500;
  overflow-wrap: anywhere;
}

.status-caption {
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
  background-color: var(--success-soft);
  border-color: var(--success);
  color: var(--success);
}

.overall-banner.is-degraded,
.overall-banner.is-maintenance {
  background-color: var(--warning-soft);
  border-color: var(--warning);
  color: var(--warning);
}

.overall-banner.is-partial_outage,
.overall-banner.is-major_outage {
  background-color: var(--error-soft);
  border-color: var(--error);
  color: var(--error);
}

.overall-banner.is-unknown {
  background-color: var(--surface-2);
  border-color: var(--border-strong);
  color: var(--muted);
}

.banner-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  background-color: currentColor;
  border-radius: 0;
}

/* States are shapes first: ■ recorded, ○ pending, ◆ alarm. */
.is-degraded .banner-dot,
.is-maintenance .banner-dot {
  background-color: transparent;
  border: 1.5px solid currentColor;
  border-radius: 50%;
}

.is-partial_outage .banner-dot,
.is-major_outage .banner-dot {
  background-color: transparent;
  border: 1.5px solid currentColor;
  transform: rotate(45deg);
}

.group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.group-title {
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-3);
}

.component-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.component {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.component-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.component-identity {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.component-label {
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.component-description {
  color: var(--muted);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

.monitor-chips {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.monitor-chip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.chip-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: var(--muted);
}

/* Shape-first states: ■ up, ◆ down, ○ maintenance. */
.chip-dot.is-up {
  background-color: var(--success);
  border-radius: 0;
}

.chip-dot.is-down {
  background-color: var(--error);
  border-radius: 0;
  transform: rotate(45deg);
}

.chip-dot.is-maintenance {
  background-color: var(--warning);
}

.chip-name {
  font-weight: 500;
  overflow-wrap: anywhere;
}

.chip-metric {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.component-uptime,
.component-chart {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.block-caption {
  color: var(--muted);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.uptime-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}

.uptime-value {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.chart-empty {
  color: var(--muted);
  font-size: 12.5px;
}

.incidents,
.maintenance {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.section-heading {
  font-size: 15px;
  font-weight: 600;
}

.incident-list,
.maintenance-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.incident,
.maintenance-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.maintenance-item {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
}

.incident-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.incident-title,
.maintenance-name {
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

.maintenance-time {
  color: var(--muted);
  font-size: 12px;
}

.timeline {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  padding: 0 0 0 var(--space-3);
  border-left: 2px solid var(--border);
  list-style: none;
}

.timeline-entry {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.timeline-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
}

.timeline-status {
  font-size: 12px;
  font-weight: 600;
}

.timeline-time {
  color: var(--muted);
  font-size: 11.5px;
}

.timeline-body {
  font-size: 13px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.status-footer {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

.footer-text {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.footer-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
}

.footer-line a {
  color: inherit;
}
</style>
