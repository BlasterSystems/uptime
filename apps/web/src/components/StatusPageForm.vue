<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { createStatusPage, errorMessage, updateStatusPage } from '../api.js'
import type {
  Monitor,
  StatusPage,
  StatusPageDark,
  StatusPageInput,
  StatusPageTheme,
} from '../api.js'
import Button from './ui/Button.vue'
import Input from './ui/Input.vue'
import Modal from './ui/Modal.vue'
import Select from './ui/Select.vue'
import Switch from './ui/Switch.vue'

const props = defineProps<{
  open: boolean
  page?: StatusPage | null
  monitors: Monitor[]
}>()

const emit = defineEmits<{ saved: []; close: [] }>()

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const DEFAULT_SWATCH = '#000000'

const DARK_OPTIONS = [
  { value: 'auto', label: 'Match viewer preference' },
  { value: 'light', label: 'Always light' },
  { value: 'dark', label: 'Always dark' },
]

const slug = ref('')
const slugError = ref<string | null>(null)
const title = ref('')
const titleError = ref<string | null>(null)
const logo = ref('')
const published = ref(true)
const selectedMonitors = ref<number[]>([])
const accent = ref('')
const accentError = ref<string | null>(null)
const dark = ref<StatusPageDark>('auto')
const submitting = ref(false)
const formError = ref<string | null>(null)

const editing = computed(() => props.page ?? null)

const isEdit = computed(() => editing.value !== null)

/** The native color input only accepts a concrete `#rrggbb` value. */
const swatchValue = computed(() => {
  const value = accent.value.trim()
  return HEX_PATTERN.test(value) ? normalizeHex(value) : DEFAULT_SWATCH
})

function normalizeHex(value: string): string {
  const body = value.slice(1).toLowerCase()
  if (body.length === 3) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`
  }
  return `#${body}`
}

function isStatusPageDark(value: string): value is StatusPageDark {
  return value === 'auto' || value === 'light' || value === 'dark'
}

function setDark(value: string): void {
  if (isStatusPageDark(value)) dark.value = value
}

function isMonitorSelected(id: number): boolean {
  return selectedMonitors.value.includes(id)
}

function toggleMonitor(id: number): void {
  selectedMonitors.value = isMonitorSelected(id)
    ? selectedMonitors.value.filter((item) => item !== id)
    : [...selectedMonitors.value, id]
}

/** Keeps the swatch and the hex text field in sync. */
function onSwatchInput(event: Event): void {
  const target = event.target
  if (target instanceof HTMLInputElement) accent.value = target.value
}

function reset(): void {
  const current = editing.value
  slug.value = current?.slug ?? ''
  title.value = current?.title ?? ''
  logo.value = current?.logo ?? ''
  published.value = current?.published ?? true
  selectedMonitors.value = current === null ? [] : [...current.monitorIds]
  accent.value = current?.theme?.accent ?? ''
  dark.value = current?.theme?.dark ?? 'auto'
  slugError.value = null
  titleError.value = null
  accentError.value = null
  formError.value = null
  submitting.value = false
}

watch(
  () => props.open,
  (open) => {
    if (open) reset()
  },
)

/** `null` when the page uses the built-in appearance. */
function buildTheme(): StatusPageTheme | null {
  const accentValue = accent.value.trim()
  const theme: StatusPageTheme = {}
  if (accentValue !== '') theme.accent = accentValue
  if (dark.value !== 'auto') theme.dark = dark.value
  return Object.keys(theme).length === 0 ? null : theme
}

async function submit(): Promise<void> {
  const trimmedSlug = slug.value.trim()
  const trimmedTitle = title.value.trim()
  const trimmedLogo = logo.value.trim()
  const accentValue = accent.value.trim()

  slugError.value =
    trimmedSlug === ''
      ? 'Enter a slug for the page.'
      : SLUG_PATTERN.test(trimmedSlug)
        ? null
        : 'Use lowercase letters, numbers and single hyphens, such as my-status.'
  titleError.value = trimmedTitle === '' ? 'Enter a title for the page.' : null
  accentError.value =
    accentValue === '' || HEX_PATTERN.test(accentValue)
      ? null
      : 'Enter a hex color such as #2563eb.'
  if (slugError.value !== null || titleError.value !== null || accentError.value !== null) return

  const input: StatusPageInput = {
    slug: trimmedSlug,
    title: trimmedTitle,
    logo: trimmedLogo === '' ? null : trimmedLogo,
    published: published.value,
    monitorIds: [...selectedMonitors.value],
    theme: buildTheme(),
  }

  submitting.value = true
  formError.value = null
  try {
    const current = editing.value
    if (current === null) {
      await createStatusPage(input)
    } else {
      await updateStatusPage(current.id, input)
    }
    emit('saved')
    emit('close')
  } catch (error) {
    formError.value = errorMessage(error, 'Could not save the status page.')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Modal
    :open="open"
    :title="isEdit ? 'Edit status page' : 'Create status page'"
    size="md"
    :close-on-backdrop="!submitting"
    @close="emit('close')"
  >
    <form class="status-form" novalidate @submit.prevent="submit">
      <div class="form-grid">
        <Input
          v-model="slug"
          label="Slug"
          placeholder="my-status"
          hint="Public URL: /status/<slug>"
          mono
          required
          :error="slugError"
        />
        <Input
          v-model="title"
          label="Title"
          placeholder="Acme status"
          required
          :error="titleError"
        />
      </div>

      <Input
        v-model="logo"
        label="Logo URL"
        type="url"
        placeholder="https://example.com/logo.svg"
        hint="Optional. Shown next to the page title."
      />

      <Switch
        v-model="published"
        label="Published"
        hint="Unpublished pages are hidden from the public."
      />

      <fieldset class="picker">
        <legend class="picker-title">Monitors</legend>
        <p v-if="monitors.length === 0" class="picker-empty">
          No monitors available yet. Create a monitor first.
        </p>
        <ul v-else class="picker-list">
          <li v-for="monitor in monitors" :key="monitor.id">
            <label class="picker-row">
              <input
                type="checkbox"
                :checked="isMonitorSelected(monitor.id)"
                @change="toggleMonitor(monitor.id)"
              />
              <span>{{ monitor.name }}</span>
            </label>
          </li>
        </ul>
      </fieldset>

      <fieldset class="theme">
        <legend class="picker-title">Theme</legend>
        <div class="theme-grid">
          <Input
            v-model="accent"
            label="Accent color"
            placeholder="#2563eb"
            hint="Optional hex color, such as #2563eb."
            mono
            :error="accentError"
          />
          <div class="swatch-field">
            <span class="swatch-caption">Swatch</span>
            <input
              type="color"
              class="swatch"
              :value="swatchValue"
              aria-label="Accent color swatch"
              @input="onSwatchInput"
            />
          </div>
        </div>
        <Select
          :model-value="dark"
          label="Dark mode"
          :options="DARK_OPTIONS"
          @update:model-value="setDark"
        />
      </fieldset>

      <p v-if="formError !== null" class="form-error" role="alert">{{ formError }}</p>
    </form>

    <template #footer>
      <Button variant="secondary" :disabled="submitting" @click="emit('close')">Cancel</Button>
      <Button variant="primary" :loading="submitting" @click="submit">
        {{ isEdit ? 'Save page' : 'Create page' }}
      </Button>
    </template>
  </Modal>
</template>

<style scoped>
.status-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--space-4);
}

.picker,
.theme {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.picker-title {
  padding: 0;
  color: var(--muted);
  font-size: 12px;
  font-weight: 550;
  letter-spacing: 0.01em;
}

.picker-list {
  max-height: 180px;
  margin: 0;
  padding: var(--space-1) var(--space-2);
  overflow-y: auto;
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  list-style: none;
}

.picker-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  font-size: 13px;
  cursor: pointer;
}

.picker-row:hover {
  background-color: var(--surface-hover);
}

.picker-row input {
  accent-color: var(--accent);
}

.picker-empty {
  padding: var(--space-3);
  background-color: var(--surface-2);
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 12.5px;
}

.theme-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 84px;
  gap: var(--space-3);
  align-items: end;
}

.swatch-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.swatch-caption {
  color: var(--muted);
  font-size: 12px;
  font-weight: 550;
}

.swatch {
  width: 100%;
  height: 38px;
  padding: 2px;
  background-color: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.form-error {
  color: var(--error);
  font-size: 13px;
}
</style>
