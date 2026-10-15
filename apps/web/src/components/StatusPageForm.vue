<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { createStatusPage, errorMessage, updateStatusPage } from '../api.js'
import type {
  Monitor,
  StatusAggregation,
  StatusPage,
  StatusPageComponent,
  StatusPageDark,
  StatusPageGroup,
  StatusPageInput,
  StatusPageStructure,
  StatusPageTheme,
} from '../api.js'
import Button from './ui/Button.vue'
import Input from './ui/Input.vue'
import Modal from './ui/Modal.vue'
import Select from './ui/Select.vue'
import Switch from './ui/Switch.vue'
import Textarea from './ui/Textarea.vue'

const props = defineProps<{
  open: boolean
  page?: StatusPage | null
  monitors: Monitor[]
}>()

const emit = defineEmits<{ saved: []; close: [] }>()

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const DEFAULT_SWATCH = '#000000'
const MAX_LABEL_LENGTH = 120
const MAX_COMPONENT_ID_LENGTH = 60

const DARK_OPTIONS = [
  { value: 'auto', label: 'Match viewer preference' },
  { value: 'light', label: 'Always light' },
  { value: 'dark', label: 'Always dark' },
]

const AGGREGATION_OPTIONS = [
  { value: 'worst', label: 'Worst monitor decides' },
  { value: 'any', label: 'Up when any monitor is up' },
]

interface ComponentErrors {
  label: string | null
  monitors: string | null
  degradedLatencyMs: string | null
}

interface ComponentDraft {
  /** Stable server id; empty for components not saved yet. */
  id: string
  label: string
  description: string
  monitorIds: number[]
  aggregation: StatusAggregation
  /** Milliseconds as text; empty means "use the page threshold". */
  degradedLatencyMs: string
  showUptime: boolean
  showChart: boolean
  errors: ComponentErrors
}

interface GroupDraft {
  name: string
  components: ComponentDraft[]
  nameError: string | null
}

const slug = ref('')
const slugError = ref<string | null>(null)
const title = ref('')
const titleError = ref<string | null>(null)
const logo = ref('')
const published = ref(true)
const accent = ref('')
const accentError = ref<string | null>(null)
const dark = ref<StatusPageDark>('auto')
const groups = ref<GroupDraft[]>([])
const footerText = ref('')
const pageLatency = ref('')
const pageLatencyError = ref<string | null>(null)
const autoPublish = ref(true)
const password = ref('')
const passwordError = ref<string | null>(null)
const clearPassword = ref(false)
const submitting = ref(false)
const formError = ref<string | null>(null)

const editing = computed(() => props.page ?? null)

const isEdit = computed(() => editing.value !== null)

const hasPassword = computed(() => editing.value?.hasPassword ?? false)

const passwordHint = computed(() => {
  if (clearPassword.value) return 'The password will be removed when you save.'
  if (hasPassword.value) return 'A password is set. Leave empty to keep it.'
  return 'Optional. Visitors must enter it to view the page.'
})

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

function isAggregation(value: string): value is StatusAggregation {
  return value === 'worst' || value === 'any'
}

function setAggregation(component: ComponentDraft, value: string): void {
  if (isAggregation(value)) component.aggregation = value
}

/** Keeps the swatch and the hex text field in sync. */
function onSwatchInput(event: Event): void {
  const target = event.target
  if (target instanceof HTMLInputElement) accent.value = target.value
}

/* Structure drafts */

function componentErrors(): ComponentErrors {
  return { label: null, monitors: null, degradedLatencyMs: null }
}

function emptyComponent(): ComponentDraft {
  return {
    id: '',
    label: '',
    description: '',
    monitorIds: [],
    aggregation: 'worst',
    degradedLatencyMs: '',
    showUptime: true,
    showChart: false,
    errors: componentErrors(),
  }
}

function emptyGroup(): GroupDraft {
  return { name: '', components: [emptyComponent()], nameError: null }
}

function draftFromStructure(structure: StatusPageStructure | null): GroupDraft[] {
  return (structure?.groups ?? []).map((group) => ({
    name: group.name,
    nameError: null,
    components: group.components.map((component) => ({
      id: component.id,
      label: component.label,
      description: component.description ?? '',
      monitorIds: [...component.monitorIds],
      aggregation: component.aggregation,
      degradedLatencyMs:
        component.degradedLatencyMs === undefined ? '' : String(component.degradedLatencyMs),
      showUptime: component.showUptime,
      showChart: component.showChart,
      errors: componentErrors(),
    })),
  }))
}

function addGroup(): void {
  groups.value = [...groups.value, emptyGroup()]
}

function removeGroup(index: number): void {
  groups.value = groups.value.filter((_, position) => position !== index)
}

function addComponent(group: GroupDraft): void {
  group.components = [...group.components, emptyComponent()]
}

function removeComponent(group: GroupDraft, index: number): void {
  group.components = group.components.filter((_, position) => position !== index)
}

function isMonitorSelected(component: ComponentDraft, id: number): boolean {
  return component.monitorIds.includes(id)
}

function toggleMonitor(component: ComponentDraft, id: number): void {
  component.monitorIds = isMonitorSelected(component, id)
    ? component.monitorIds.filter((item) => item !== id)
    : [...component.monitorIds, id]
}

/** `label` → `component-id`, mirroring the core slug rule `^[a-z0-9-]{1,60}$`. */
function slugify(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_COMPONENT_ID_LENGTH)
    .replace(/-+$/g, '')
}

/** New components get a page-unique id derived from their label. */
function uniqueComponentId(label: string, used: ReadonlySet<string>): string {
  const root = slugify(label) === '' ? 'component' : slugify(label)
  if (!used.has(root)) return root
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`
    const candidate = `${root.slice(0, MAX_COMPONENT_ID_LENGTH - tail.length)}${tail}`
    if (!used.has(candidate)) return candidate
  }
}

function buildStructure(): StatusPageStructure {
  // Existing ids are reserved up front so a new component's generated id can
  // never collide with a saved one further down the page.
  const used = new Set<string>()
  for (const group of groups.value) {
    for (const component of group.components) {
      if (component.id !== '') used.add(component.id)
    }
  }

  const structureGroups: StatusPageGroup[] = groups.value.map((group) => ({
    name: group.name.trim(),
    components: group.components.map((component) => {
      const id = component.id !== '' ? component.id : uniqueComponentId(component.label, used)
      used.add(id)

      const built: StatusPageComponent = {
        id,
        label: component.label.trim(),
        monitorIds: [...component.monitorIds],
        aggregation: component.aggregation,
        showUptime: component.showUptime,
        showChart: component.showChart,
      }
      const description = component.description.trim()
      if (description !== '') built.description = description
      const degraded = component.degradedLatencyMs.trim()
      if (degraded !== '') built.degradedLatencyMs = Number(degraded)
      return built
    }),
  }))

  const structure: StatusPageStructure = { groups: structureGroups, autoPublish: autoPublish.value }
  const degraded = pageLatency.value.trim()
  if (degraded !== '') structure.degradedLatencyMs = Number(degraded)
  return structure
}

/* Form lifecycle */

function reset(): void {
  const current = editing.value
  slug.value = current?.slug ?? ''
  title.value = current?.title ?? ''
  logo.value = current?.logo ?? ''
  published.value = current?.published ?? true
  accent.value = current?.theme?.accent ?? ''
  dark.value = current?.theme?.dark ?? 'auto'
  groups.value = draftFromStructure(current?.structure ?? null)
  footerText.value = current?.footerText ?? ''
  const storedLatency = current?.structure?.degradedLatencyMs
  pageLatency.value = storedLatency === undefined ? '' : String(storedLatency)
  autoPublish.value = current?.structure?.autoPublish ?? true
  password.value = ''
  clearPassword.value = false
  slugError.value = null
  titleError.value = null
  accentError.value = null
  pageLatencyError.value = null
  passwordError.value = null
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

function positiveInteger(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) > 0
}

function validateStructure(): boolean {
  let valid = true
  for (const group of groups.value) {
    group.nameError = group.name.trim() === '' ? 'Enter a group name.' : null
    if (group.nameError !== null) valid = false
    for (const component of group.components) {
      const label = component.label.trim()
      component.errors.label =
        label === ''
          ? 'Enter a label.'
          : label.length > MAX_LABEL_LENGTH
            ? `Keep the label under ${MAX_LABEL_LENGTH} characters.`
            : null
      component.errors.monitors =
        component.monitorIds.length === 0 ? 'Select at least one monitor.' : null
      const degraded = component.degradedLatencyMs.trim()
      component.errors.degradedLatencyMs =
        degraded === '' || positiveInteger(degraded)
          ? null
          : 'Enter a positive number of milliseconds.'
      if (
        component.errors.label !== null ||
        component.errors.monitors !== null ||
        component.errors.degradedLatencyMs !== null
      ) {
        valid = false
      }
    }
  }
  return valid
}

async function submit(): Promise<void> {
  const trimmedSlug = slug.value.trim()
  const trimmedTitle = title.value.trim()
  const trimmedLogo = logo.value.trim()
  const accentValue = accent.value.trim()
  const degradedPage = pageLatency.value.trim()

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
  pageLatencyError.value =
    degradedPage === '' || positiveInteger(degradedPage)
      ? null
      : 'Enter a positive number of milliseconds.'
  passwordError.value =
    clearPassword.value && password.value !== ''
      ? 'Remove the new password or turn off the clear switch.'
      : null
  const structureValid = validateStructure()
  if (
    slugError.value !== null ||
    titleError.value !== null ||
    accentError.value !== null ||
    pageLatencyError.value !== null ||
    passwordError.value !== null ||
    !structureValid
  ) {
    return
  }

  const monitorIds = [
    ...new Set(
      groups.value.flatMap((group) => group.components.flatMap((item) => item.monitorIds)),
    ),
  ]

  const input: StatusPageInput = {
    slug: trimmedSlug,
    title: trimmedTitle,
    logo: trimmedLogo === '' ? null : trimmedLogo,
    published: published.value,
    monitorIds,
    theme: buildTheme(),
    structure: buildStructure(),
    footerText: footerText.value.trim() === '' ? null : footerText.value.trim(),
  }
  if (clearPassword.value) input.password = null
  else if (password.value !== '') input.password = password.value

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
    size="lg"
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

      <fieldset class="structure">
        <legend class="picker-title">Components</legend>
        <p class="field-hint">
          Components are what visitors watch. Each one rolls up one or more monitors — a web app and
          its worker, a push pulse — into a single status.
        </p>
        <p v-if="monitors.length === 0" class="picker-empty">
          No monitors available yet. Create a monitor first.
        </p>

        <div v-for="(group, groupIndex) in groups" :key="groupIndex" class="group-card">
          <div class="group-head">
            <Input
              v-model="group.name"
              label="Group name"
              placeholder="Core platform"
              :error="group.nameError"
            />
            <Button variant="ghost" size="sm" @click="removeGroup(groupIndex)">
              Remove group
            </Button>
          </div>

          <div
            v-for="(component, componentIndex) in group.components"
            :key="componentIndex"
            class="component-card"
          >
            <div class="component-head">
              <span class="component-caption">
                {{ component.label.trim() === '' ? 'New component' : component.label }}
              </span>
              <Button variant="ghost" size="sm" @click="removeComponent(group, componentIndex)">
                Remove component
              </Button>
            </div>

            <div class="form-grid">
              <Input
                v-model="component.label"
                label="Label"
                placeholder="API"
                required
                :error="component.errors.label"
              />
              <Input
                v-model="component.description"
                label="Description"
                placeholder="Public REST API"
                hint="Optional. Shown under the label."
              />
              <Select
                :model-value="component.aggregation"
                label="Aggregation"
                :options="AGGREGATION_OPTIONS"
                @update:model-value="setAggregation(component, $event)"
              />
              <Input
                v-model="component.degradedLatencyMs"
                label="Degraded above (ms)"
                type="number"
                min="1"
                placeholder="800"
                hint="Optional. Overrides the page threshold."
                :error="component.errors.degradedLatencyMs"
              />
            </div>

            <fieldset class="picker">
              <legend class="picker-title">Monitors</legend>
              <ul class="picker-list">
                <li v-for="monitor in monitors" :key="monitor.id">
                  <label class="picker-row">
                    <input
                      type="checkbox"
                      :checked="isMonitorSelected(component, monitor.id)"
                      @change="toggleMonitor(component, monitor.id)"
                    />
                    <span>{{ monitor.name }}</span>
                  </label>
                </li>
              </ul>
              <p v-if="component.errors.monitors !== null" class="field-error" role="alert">
                {{ component.errors.monitors }}
              </p>
            </fieldset>

            <div class="switch-grid">
              <Switch
                v-model="component.showUptime"
                label="Show uptime"
                hint="90-day availability bars on the page."
              />
              <Switch
                v-model="component.showChart"
                label="Show chart"
                hint="24-hour response-time chart on the page."
              />
            </div>
          </div>

          <Button variant="secondary" size="sm" @click="addComponent(group)">
            Add component
          </Button>
        </div>

        <Button variant="secondary" size="sm" @click="addGroup">Add group</Button>
      </fieldset>

      <fieldset class="access">
        <legend class="picker-title">Page</legend>
        <Textarea
          v-model="footerText"
          label="Footer text"
          placeholder="Operated by Acme — status@acme.example"
          hint="Optional line under the components."
          :rows="2"
        />
        <Input
          v-model="pageLatency"
          label="Degraded above (ms)"
          type="number"
          min="1"
          placeholder="800"
          hint="Optional page-wide latency threshold; component values override it."
          :error="pageLatencyError"
        />
        <Switch
          v-model="autoPublish"
          label="Auto-publish incidents"
          hint="Monitor incidents on these components appear on the page automatically."
        />
      </fieldset>

      <fieldset class="access">
        <legend class="picker-title">Password</legend>
        <Input
          v-model="password"
          label="Password"
          type="password"
          autocomplete="new-password"
          :hint="passwordHint"
          :error="passwordError"
          :disabled="clearPassword"
        />
        <Switch
          v-if="hasPassword"
          v-model="clearPassword"
          label="Clear password"
          hint="Makes the page public again."
        />
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

.structure,
.access {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

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
  font-weight: 500;
  letter-spacing: 0.01em;
}

.field-hint {
  color: var(--muted);
  font-size: 12.5px;
}

.field-error {
  color: var(--thread-ink);
  font-size: 12.5px;
}

.group-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.group-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3);
}

.group-head :deep(.field) {
  flex-grow: 1;
}

.component-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.component-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.component-caption {
  font-size: 12.5px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.picker-list {
  max-height: 160px;
  margin: 0;
  padding: var(--space-1) var(--space-2);
  overflow-y: auto;
  background-color: var(--surface);
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

.switch-grid {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-5);
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
  font-weight: 500;
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
  color: var(--thread-ink);
  font-size: 13px;
}
</style>
