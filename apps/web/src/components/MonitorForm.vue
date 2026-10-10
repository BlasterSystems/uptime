<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  MIN_INTERVAL_S,
  createMonitor,
  errorMessage,
  fetchChannels,
  fetchTags,
  updateMonitor,
} from '../api.js'
import type { Channel, Monitor, MonitorInput, MonitorType, Tag } from '../api.js'
import { copyText } from '../clipboard.js'
import Badge from './ui/Badge.vue'
import Button from './ui/Button.vue'
import Icon from './ui/Icon.vue'
import Input from './ui/Input.vue'
import Modal from './ui/Modal.vue'
import Select from './ui/Select.vue'
import Switch from './ui/Switch.vue'
import { useToast } from './ui/toast.js'

const props = withDefaults(defineProps<{ open: boolean; monitor?: Monitor | null }>(), {
  monitor: null,
})
const emit = defineEmits<{ created: [monitor: Monitor]; saved: [monitor: Monitor]; close: [] }>()

const toast = useToast()

/** Monitor being edited; `null` keeps the form in create mode. */
const editingMonitor = computed<Monitor | null>(() => props.monitor ?? null)
const isEdit = computed(() => editingMonitor.value !== null)

const form = reactive({
  name: '',
  type: 'http' as MonitorType,
  url: '',
  timeoutMs: '10000',
  graceSeconds: '60',
  intervalS: '60',
  retries: '0',
  tagText: '',
})

const errors = reactive({
  name: null as string | null,
  url: null as string | null,
  timeoutMs: null as string | null,
  graceSeconds: null as string | null,
  intervalS: null as string | null,
  retries: null as string | null,
})

const optionsLoading = ref(false)
const optionsError = ref<string | null>(null)
const tags = ref<Tag[]>([])
const channels = ref<Channel[]>([])
const selectedChannelIds = ref<number[]>([])
const submitting = ref(false)
const formError = ref<string | null>(null)
const created = ref<Monitor | null>(null)

const modalTitle = computed(() => {
  if (created.value !== null) return 'Monitor created'
  return isEdit.value ? 'Edit monitor' : 'Add monitor'
})

const typeOptions = [
  { value: 'http', label: 'HTTP — poll a URL on a schedule' },
  { value: 'push', label: 'Push — wait for an incoming heartbeat' },
]

/** Tag names typed into the input; the server creates unknown tags implicitly. */
function parseTagNames(value: string): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const chunk of value.split(',')) {
    const name = chunk.trim()
    if (name === '') continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

const tagNames = computed(() => parseTagNames(form.tagText))

function isTagSelected(tag: Tag): boolean {
  return tagNames.value.some((name) => name.toLowerCase() === tag.name.toLowerCase())
}

function toggleTag(tag: Tag): void {
  const selected = isTagSelected(tag)
  const names = selected
    ? tagNames.value.filter((name) => name.toLowerCase() !== tag.name.toLowerCase())
    : [...tagNames.value, tag.name]
  form.tagText = names.join(', ')
}

function isChannelSelected(id: number): boolean {
  return selectedChannelIds.value.includes(id)
}

function toggleChannel(id: number): void {
  selectedChannelIds.value = isChannelSelected(id)
    ? selectedChannelIds.value.filter((item) => item !== id)
    : [...selectedChannelIds.value, id]
}

const pushUrl = computed(() => {
  const url = created.value?.pushUrl
  if (url === undefined) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url
  return `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`
})

function reset(): void {
  form.name = ''
  form.type = 'http'
  form.url = ''
  form.timeoutMs = '10000'
  form.graceSeconds = '60'
  form.intervalS = '60'
  form.retries = '0'
  form.tagText = ''
  errors.name = null
  errors.url = null
  errors.timeoutMs = null
  errors.graceSeconds = null
  errors.intervalS = null
  errors.retries = null
  selectedChannelIds.value = []
  formError.value = null
  created.value = null
}

async function loadOptions(): Promise<void> {
  optionsLoading.value = true
  optionsError.value = null
  try {
    const [loadedTags, loadedChannels] = await Promise.all([fetchTags(), fetchChannels()])
    tags.value = loadedTags
    channels.value = loadedChannels
  } catch (error) {
    optionsError.value = errorMessage(error, 'Could not load tags and channels.')
  } finally {
    optionsLoading.value = false
  }
}

/** Changes only when the dialog opens/closes or is repointed at another monitor. */
const prefillKey = computed(() => {
  if (!props.open) return null
  const monitor = editingMonitor.value
  return monitor === null ? 'create' : `edit:${monitor.id}`
})

watch(prefillKey, (key) => {
  if (key === null) return
  reset()
  const monitor = editingMonitor.value
  if (monitor !== null) {
    form.name = monitor.name
    form.type = monitor.type
    form.url = monitor.config.url ?? ''
    if (monitor.config.timeoutMs !== undefined) {
      form.timeoutMs = String(monitor.config.timeoutMs)
    }
    if (monitor.config.graceSeconds !== undefined) {
      form.graceSeconds = String(monitor.config.graceSeconds)
    }
    form.intervalS = String(monitor.intervalS)
    form.retries = String(monitor.retries)
    form.tagText = monitor.tags.map((tag) => tag.name).join(', ')
    selectedChannelIds.value = [...monitor.channelIds]
  }
  void loadOptions()
})

function integerField(value: string, min: number): number | null {
  const parsed = Number(value)
  if (value.trim() === '' || !Number.isInteger(parsed) || parsed < min) return null
  return parsed
}

function buildPayload(): MonitorInput | null {
  errors.name = form.name.trim() === '' ? 'Enter a name.' : null

  let config: Record<string, unknown> = {}
  if (form.type === 'http') {
    errors.graceSeconds = null
    const url = form.url.trim()
    if (url === '') {
      errors.url = 'Enter the URL to check.'
    } else {
      try {
        const parsed = new URL(url)
        errors.url =
          parsed.protocol === 'http:' || parsed.protocol === 'https:'
            ? null
            : 'Use an http or https URL.'
      } catch {
        errors.url = 'Enter a valid absolute URL.'
      }
    }

    const timeoutMs = integerField(form.timeoutMs, 1)
    errors.timeoutMs = timeoutMs === null ? 'Enter a timeout of at least 1 ms.' : null
    if (timeoutMs !== null) config = { url, timeoutMs }
  } else {
    errors.url = null
    errors.timeoutMs = null
    const graceSeconds = integerField(form.graceSeconds, 1)
    errors.graceSeconds = graceSeconds === null ? 'Enter a grace period of at least 1 s.' : null
    if (graceSeconds !== null) config = { graceSeconds }
  }

  const intervalS = integerField(form.intervalS, MIN_INTERVAL_S)
  errors.intervalS =
    intervalS === null ? `Enter an interval of at least ${MIN_INTERVAL_S} s.` : null

  const retries = integerField(form.retries, 0)
  errors.retries = retries === null ? 'Enter zero or more retries.' : null

  if (
    errors.name !== null ||
    errors.url !== null ||
    errors.timeoutMs !== null ||
    errors.graceSeconds !== null ||
    errors.intervalS !== null ||
    errors.retries !== null
  ) {
    return null
  }

  const names = tagNames.value
  return {
    name: form.name.trim(),
    type: form.type,
    config,
    intervalS: intervalS as number,
    retries: retries as number,
    channelIds: selectedChannelIds.value,
    ...(names.length === 0 ? {} : { tags: names }),
  }
}

async function submit(): Promise<void> {
  const payload = buildPayload()
  if (payload === null) return

  submitting.value = true
  formError.value = null
  try {
    const editing = editingMonitor.value
    if (editing !== null) {
      const updated = await updateMonitor(editing.id, payload)
      emit('saved', updated)
      toast.success('Monitor updated', updated.name)
      emit('close')
      return
    }
    const monitor = await createMonitor(payload)
    created.value = monitor
    emit('created', monitor)
    if (monitor.pushUrl === undefined) emit('close')
  } catch (error) {
    formError.value = errorMessage(
      error,
      isEdit.value ? 'Could not save the monitor.' : 'Could not create the monitor.',
    )
  } finally {
    submitting.value = false
  }
}

async function copyPushUrl(): Promise<void> {
  if (pushUrl.value === null) return
  const copied = await copyText(pushUrl.value)
  if (copied) {
    toast.success('Push URL copied')
    return
  }
  toast.error('Copy failed', 'Select the URL and copy it manually.')
}
</script>

<template>
  <Modal
    :open="open"
    :title="modalTitle"
    size="lg"
    :close-on-backdrop="created === null"
    @close="emit('close')"
  >
    <div v-if="created !== null" class="created">
      <p class="created-lead">
        <Badge variant="success" dot>Active</Badge>
        <span class="created-name">{{ created.name }}</span>
      </p>
      <template v-if="pushUrl !== null">
        <p class="created-copy">
          Send a GET or POST request to this URL on every heartbeat. The monitor turns down once the
          grace period passes without a heartbeat.
        </p>
        <div class="copy-row">
          <code class="copy-value mono">{{ pushUrl }}</code>
          <Button variant="secondary" size="sm" @click="copyPushUrl">
            <Icon name="copy" :size="14" />
            Copy
          </Button>
        </div>
      </template>
      <p v-else class="created-copy">
        The monitor is checking now. Heartbeats appear on the dashboard after the first run.
      </p>
    </div>

    <form v-else class="monitor-form" novalidate @submit.prevent="submit">
      <div class="form-grid">
        <Input
          v-model="form.name"
          label="Name"
          placeholder="Marketing site"
          :error="errors.name"
          required
        />
        <Select v-model="form.type" label="Type" :options="typeOptions" />
      </div>

      <template v-if="form.type === 'http'">
        <Input
          v-model="form.url"
          label="URL"
          type="url"
          placeholder="https://example.com"
          autocomplete="off"
          :error="errors.url"
          required
        />
        <Input
          v-model="form.timeoutMs"
          label="Timeout"
          type="number"
          min="1"
          step="500"
          hint="Request timeout in milliseconds."
          :error="errors.timeoutMs"
        />
      </template>
      <Input
        v-else
        v-model="form.graceSeconds"
        label="Grace period"
        type="number"
        min="1"
        step="10"
        hint="Extra time allowed on top of the interval before the monitor is marked down."
        :error="errors.graceSeconds"
      />

      <div class="form-grid">
        <Input
          v-model="form.intervalS"
          :label="form.type === 'http' ? 'Check interval' : 'Expected interval'"
          type="number"
          :min="MIN_INTERVAL_S"
          step="10"
          :hint="`Seconds; minimum ${MIN_INTERVAL_S}.`"
          :error="errors.intervalS"
        />
        <Input
          v-model="form.retries"
          label="Retries"
          type="number"
          min="0"
          step="1"
          hint="Consecutive failures tolerated before an incident opens."
          :error="errors.retries"
        />
      </div>

      <div class="section">
        <p class="section-title">Tags</p>
        <Input
          v-model="form.tagText"
          placeholder="production, external"
          hint="Comma-separated; tags are created automatically when new."
        />
        <div v-if="optionsLoading" class="section-note">Loading tags…</div>
        <div v-else-if="tags.length > 0" class="chip-row">
          <button
            v-for="tag in tags"
            :key="tag.id"
            type="button"
            class="chip"
            :class="{ 'is-active': isTagSelected(tag) }"
            :aria-pressed="isTagSelected(tag)"
            @click="toggleTag(tag)"
          >
            <span class="chip-dot" :style="{ backgroundColor: tag.color }" aria-hidden="true" />
            {{ tag.name }}
          </button>
        </div>
      </div>

      <div class="section">
        <p class="section-title">Notification channels</p>
        <div v-if="optionsLoading" class="section-note">Loading channels…</div>
        <div v-else-if="channels.length === 0" class="section-note">
          No channels configured yet — add one under Notifications to get alerts.
        </div>
        <div v-else class="switch-list">
          <Switch
            v-for="channel in channels"
            :key="channel.id"
            :model-value="isChannelSelected(channel.id)"
            :label="channel.name"
            :hint="`${channel.type}${channel.isDefault ? ' · default' : ''}${channel.active ? '' : ' · inactive'}`"
            @update:model-value="toggleChannel(channel.id)"
          />
        </div>
        <p v-if="optionsError !== null" class="form-error" role="alert">{{ optionsError }}</p>
      </div>

      <p v-if="formError !== null" class="form-error" role="alert">{{ formError }}</p>
    </form>

    <template #footer>
      <template v-if="created !== null">
        <Button variant="primary" @click="emit('close')">Done</Button>
      </template>
      <template v-else>
        <Button variant="secondary" :disabled="submitting" @click="emit('close')">Cancel</Button>
        <Button variant="primary" :loading="submitting" @click="submit">
          {{ isEdit ? 'Save changes' : 'Create monitor' }}
        </Button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.monitor-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-4);
}

.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
}

.section-title {
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.section-note {
  color: var(--muted);
  font-size: 12.5px;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}

.chip:hover {
  color: var(--fg);
}

.chip.is-active {
  background-color: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  color: var(--accent);
}

.chip-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.switch-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.form-error {
  color: var(--error);
  font-size: 13px;
}

.created {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.created-lead {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.created-name {
  font-weight: 600;
}

.created-copy {
  color: var(--muted);
  font-size: 13px;
}

.copy-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.copy-value {
  flex-grow: 1;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
}
</style>
