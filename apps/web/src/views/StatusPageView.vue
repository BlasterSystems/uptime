<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import { useRoute } from 'vue-router'
import { ApiError, errorMessage, fetchPublicStatus } from '../api.js'
import type { HeartbeatStatus, PublicStatusPage } from '../api.js'
import Badge from '../components/ui/Badge.vue'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import Spinner from '../components/ui/Spinner.vue'
import { formatDateTime, formatLatency, relativeTime } from '../format.js'

const STATUS_META: Record<
  HeartbeatStatus,
  { label: string; variant: 'success' | 'error' | 'warning' | 'neutral' }
> = {
  up: { label: 'Up', variant: 'success' },
  down: { label: 'Down', variant: 'error' },
  pending: { label: 'Pending', variant: 'neutral' },
  maintenance: { label: 'Maintenance', variant: 'warning' },
}

const DARK_ACCENT_FG = '#06111f'
const WHITE = '#ffffff'
/** #06111f as channels — used for the contrast check against a custom accent. */
const DARK_ACCENT_RGB: [number, number, number] = [6, 17, 31]
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

const route = useRoute()

const slug = computed(() => String(route.params.slug ?? ''))
const page = ref<PublicStatusPage | null>(null)
const loading = ref(true)
const notFound = ref(false)
const loadError = ref<string | null>(null)

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

const incidentSummary = computed(() => {
  const count = page.value?.incidents.length ?? 0
  return count === 1 ? '1 open incident' : `${count} open incidents`
})

const mark = computed(() => {
  const title = page.value?.title.trim() ?? ''
  return title === '' ? 'U' : title.charAt(0).toUpperCase()
})

let loadSeq = 0

async function load(): Promise<void> {
  const seq = ++loadSeq
  loading.value = true
  notFound.value = false
  loadError.value = null
  try {
    const loaded = await fetchPublicStatus(slug.value)
    if (seq !== loadSeq) return
    page.value = loaded
    document.title = `${loaded.title} · Status`
  } catch (error) {
    if (seq !== loadSeq) return
    page.value = null
    if (error instanceof ApiError && error.status === 404) {
      notFound.value = true
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

onMounted(() => {
  darkQuery.addEventListener('change', onSystemThemeChange)
  void load()
})

onUnmounted(() => {
  darkQuery.removeEventListener('change', onSystemThemeChange)
})

watch(slug, () => void load())
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

        <div
          class="overall-banner"
          :class="page.incidents.length > 0 ? 'is-incident' : 'is-ok'"
          role="status"
        >
          <span class="banner-dot" aria-hidden="true" />
          <span v-if="page.incidents.length > 0">Incident in progress — {{ incidentSummary }}</span>
          <span v-else>All systems operational</span>
        </div>

        <div v-if="page.monitors.length === 0" class="panel">
          <EmptyState
            title="No monitors on this page"
            description="The operator has not published any monitors yet."
          />
        </div>

        <section v-else aria-label="Monitors">
          <ul class="monitor-list">
            <li v-for="monitor in page.monitors" :key="monitor.id" class="monitor-row">
              <div class="monitor-identity">
                <span class="monitor-name">{{ monitor.name }}</span>
                <span v-if="monitor.tags.length > 0" class="monitor-tags">
                  <span v-for="tag in monitor.tags" :key="tag.id" class="tag-chip">
                    <span
                      class="tag-dot"
                      :style="{ backgroundColor: tag.color }"
                      aria-hidden="true"
                    />
                    {{ tag.name }}
                  </span>
                </span>
              </div>
              <div class="monitor-metrics">
                <dl class="monitor-facts">
                  <div class="metric">
                    <dt>Latency</dt>
                    <dd>{{ formatLatency(monitor.latencyMs) }}</dd>
                  </div>
                  <div class="metric">
                    <dt>Uptime 24h</dt>
                    <dd>{{ formatUptime(monitor.uptimePct) }}</dd>
                  </div>
                </dl>
                <Badge :variant="STATUS_META[monitor.status].variant" dot>
                  {{ STATUS_META[monitor.status].label }}
                </Badge>
              </div>
            </li>
          </ul>
        </section>

        <section
          v-if="page.incidents.length > 0"
          class="incidents"
          aria-labelledby="open-incidents-title"
        >
          <h2 id="open-incidents-title" class="incidents-title">Open incidents</h2>
          <ul class="incident-list">
            <li v-for="incident in page.incidents" :key="incident.id" class="incident">
              <h3 class="incident-title">{{ incident.title }}</h3>
              <p class="incident-meta">
                <span>{{ incident.monitorName }}</span>
                <span>Opened {{ formatDateTime(incident.openedAt) }}</span>
                <span>{{ relativeTime(incident.openedAt) }}</span>
              </p>
              <p v-if="incident.body !== null" class="incident-body">{{ incident.body }}</p>
            </li>
          </ul>
        </section>

        <footer class="status-footer">Powered by Uptime</footer>
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
  --radius-sm: 6px;
  --radius: 10px;
  --radius-lg: 14px;

  min-height: 100vh;
  background-color: var(--bg);
  color: var(--fg);
}

.status-shell[data-theme='light'] {
  color-scheme: light;

  --bg: #f4f6f9;
  --surface: #ffffff;
  --surface-2: #eef1f6;
  --surface-hover: #e7ebf2;
  --border: #d9dfe9;
  --border-strong: #c3cbd9;
  --fg: #111721;
  --muted: #57637a;
  --accent: #2563eb;
  --accent-fg: #ffffff;
  --success: #15803d;
  --success-soft: rgb(21 128 61 / 0.12);
  --warning: #a2570a;
  --warning-soft: rgb(161 87 10 / 0.13);
  --error: #cf2f2f;
  --error-soft: rgb(207 47 47 / 0.11);
  --overlay: rgb(15 21 33 / 0.45);
  --shadow: 0 1px 2px rgb(17 23 33 / 0.05), 0 10px 24px -18px rgb(17 23 33 / 0.28);
  --shadow-lg: 0 24px 60px -24px rgb(17 23 33 / 0.4);
}

.status-shell[data-theme='dark'] {
  color-scheme: dark;

  --bg: #0b0f14;
  --surface: #121821;
  --surface-2: #18202b;
  --surface-hover: #1f2836;
  --border: #232d3b;
  --border-strong: #334052;
  --fg: #e6edf3;
  --muted: #97a3b6;
  --accent: #60a5fa;
  --accent-fg: #06111f;
  --success: #4ade80;
  --success-soft: rgb(74 222 128 / 0.14);
  --warning: #fbbf24;
  --warning-soft: rgb(251 191 36 / 0.14);
  --error: #f87171;
  --error-soft: rgb(248 113 113 / 0.14);
  --overlay: rgb(3 6 10 / 0.62);
  --shadow: 0 1px 2px rgb(0 0 0 / 0.35), 0 12px 28px -20px rgb(0 0 0 / 0.7);
  --shadow-lg: 0 28px 64px -28px rgb(0 0 0 / 0.8);
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
  font-weight: 700;
}

.state-text {
  max-width: 46ch;
  color: var(--muted);
  font-size: 13.5px;
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
  border-radius: 9px;
  color: var(--accent-fg);
  font-size: 14px;
  font-weight: 700;
}

.status-heading {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.status-title {
  font-size: 20px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.status-caption {
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
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
  font-weight: 550;
}

.overall-banner.is-ok {
  background-color: var(--success-soft);
  border-color: var(--success);
  color: var(--success);
}

.overall-banner.is-incident {
  background-color: var(--error-soft);
  border-color: var(--error);
  color: var(--error);
}

.banner-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  background-color: currentColor;
  border-radius: 50%;
}

.monitor-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.monitor-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
  padding: var(--space-3) var(--space-4);
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.monitor-identity {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.monitor-name {
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.monitor-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
  font-size: 11px;
}

.tag-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.monitor-metrics {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.monitor-facts {
  display: flex;
  gap: var(--space-4);
  margin: 0;
}

.metric {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
}

.metric dt {
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.metric dd {
  margin: 0;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.incidents {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.incidents-title {
  font-size: 15px;
  font-weight: 650;
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

.incident-body {
  font-size: 13px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.status-footer {
  padding-top: var(--space-2);
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

@media (max-width: 560px) {
  .monitor-metrics {
    width: 100%;
    justify-content: space-between;
  }
}
</style>
