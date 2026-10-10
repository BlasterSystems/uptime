<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { createMaintenanceWindow, errorMessage, updateMaintenanceWindow } from '../api.js'
import type {
  MaintenanceScope,
  MaintenanceStrategy,
  MaintenanceWindow,
  MaintenanceWindowInput,
  Monitor,
  Tag,
} from '../api.js'
import Button from './ui/Button.vue'
import Input from './ui/Input.vue'
import Modal from './ui/Modal.vue'
import Select from './ui/Select.vue'
import Switch from './ui/Switch.vue'

const props = defineProps<{
  open: boolean
  window?: MaintenanceWindow | null
  monitors: Monitor[]
  tags: Tag[]
}>()

const emit = defineEmits<{ saved: []; close: [] }>()

const SCOPE_OPTIONS = [
  { value: 'all', label: 'All monitors' },
  { value: 'ids', label: 'Selected monitors' },
  { value: 'tags', label: 'Tagged monitors' },
]

const STRATEGY_OPTIONS = [
  { value: 'single', label: 'Single window' },
  { value: 'recurring-interval', label: 'Repeats on an interval' },
  { value: 'recurring-weekday', label: 'Weekly schedule' },
  { value: 'cron', label: 'Cron schedule' },
]

/** Indices match `MaintenanceWindow.weekdays` (`0` = Sunday). */
const WEEKDAYS = [
  { value: 0, short: 'Sun', label: 'Sunday' },
  { value: 1, short: 'Mon', label: 'Monday' },
  { value: 2, short: 'Tue', label: 'Tuesday' },
  { value: 3, short: 'Wed', label: 'Wednesday' },
  { value: 4, short: 'Thu', label: 'Thursday' },
  { value: 5, short: 'Fri', label: 'Friday' },
  { value: 6, short: 'Sat', label: 'Saturday' },
]

const name = ref('')
const nameError = ref<string | null>(null)
const active = ref(true)
const scope = ref<MaintenanceScope>('all')
const selectedMonitors = ref<number[]>([])
const monitorError = ref<string | null>(null)
const selectedTags = ref<number[]>([])
const tagError = ref<string | null>(null)
const strategy = ref<MaintenanceStrategy>('single')
const startAt = ref('')
const startAtError = ref<string | null>(null)
const endAt = ref('')
const endAtError = ref<string | null>(null)
const intervalS = ref('')
const intervalError = ref<string | null>(null)
const startTime = ref('')
const startTimeError = ref<string | null>(null)
const endTime = ref('')
const endTimeError = ref<string | null>(null)
const weekdays = ref<number[]>([])
const weekdaysError = ref<string | null>(null)
const cronExpr = ref('')
const cronError = ref<string | null>(null)
const cronTz = ref('UTC')
const cronTzError = ref<string | null>(null)
const submitting = ref(false)
const formError = ref<string | null>(null)

const editing = computed(() => props.window ?? null)

const isEdit = computed(() => editing.value !== null)

function isScope(value: string): value is MaintenanceScope {
  return value === 'all' || value === 'ids' || value === 'tags'
}

function isStrategy(value: string): value is MaintenanceStrategy {
  return (
    value === 'single' ||
    value === 'recurring-interval' ||
    value === 'recurring-weekday' ||
    value === 'cron'
  )
}

function setScope(value: string): void {
  if (isScope(value)) scope.value = value
}

function setStrategy(value: string): void {
  if (isStrategy(value)) strategy.value = value
}

function isMonitorSelected(id: number): boolean {
  return selectedMonitors.value.includes(id)
}

function toggleMonitor(id: number): void {
  selectedMonitors.value = isMonitorSelected(id)
    ? selectedMonitors.value.filter((item) => item !== id)
    : [...selectedMonitors.value, id]
}

function isTagSelected(id: number): boolean {
  return selectedTags.value.includes(id)
}

function toggleTag(id: number): void {
  selectedTags.value = isTagSelected(id)
    ? selectedTags.value.filter((item) => item !== id)
    : [...selectedTags.value, id]
}

function isWeekdaySelected(day: number): boolean {
  return weekdays.value.includes(day)
}

function toggleWeekday(day: number): void {
  weekdays.value = isWeekdaySelected(day)
    ? weekdays.value.filter((value) => value !== day)
    : [...weekdays.value, day].sort((left, right) => left - right)
}

/** `datetime-local` fields want a wall-clock value in the viewer's timezone. */
function toLocalInput(iso: string | null): string {
  if (iso === null || iso === '') return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

/** Sends the typed wall-clock time as the instant the operator meant. */
function toIso(local: string): string | null {
  if (local === '') return null
  const date = new Date(local)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function reset(): void {
  const current = editing.value
  name.value = current?.name ?? ''
  active.value = current?.active ?? true
  scope.value = current?.scope ?? 'all'
  selectedMonitors.value = current === null ? [] : [...current.monitorIds]
  selectedTags.value = current === null ? [] : [...current.tagIds]
  strategy.value = current?.strategy ?? 'single'
  startAt.value = toLocalInput(current?.startAt ?? null)
  endAt.value = toLocalInput(current?.endAt ?? null)
  intervalS.value =
    current?.intervalS === null || current?.intervalS === undefined ? '' : String(current.intervalS)
  startTime.value = current?.startTime ?? ''
  endTime.value = current?.endTime ?? ''
  weekdays.value = current === null ? [] : [...current.weekdays]
  cronExpr.value = current?.cronExpr ?? ''
  cronTz.value = current?.cronTz ?? 'UTC'
  nameError.value = null
  monitorError.value = null
  tagError.value = null
  startAtError.value = null
  endAtError.value = null
  intervalError.value = null
  startTimeError.value = null
  endTimeError.value = null
  weekdaysError.value = null
  cronError.value = null
  cronTzError.value = null
  formError.value = null
  submitting.value = false
}

watch(
  () => props.open,
  (open) => {
    if (open) reset()
  },
)

function isAfter(later: string, earlier: string): boolean {
  const end = new Date(later).getTime()
  const start = new Date(earlier).getTime()
  return Number.isFinite(end) && Number.isFinite(start) && end > start
}

/** The `HH:MM` bounds are optional as a pair; when either is set, both must be ordered. */
function validateOptionalTimes(): void {
  const from = startTime.value
  const to = endTime.value
  if (from === '' && to === '') return
  if (from === '') {
    startTimeError.value = 'Enter both the start and end time.'
    return
  }
  if (to === '') {
    endTimeError.value = 'Enter both the start and end time.'
    return
  }
  if (from >= to) endTimeError.value = 'The end time must be after the start time.'
}

function validateStrategy(): void {
  if (strategy.value === 'single') {
    startAtError.value = startAt.value === '' ? 'Enter when the window starts.' : null
    endAtError.value = endAt.value === '' ? 'Enter when the window ends.' : null
    if (
      startAtError.value === null &&
      endAtError.value === null &&
      !isAfter(endAt.value, startAt.value)
    ) {
      endAtError.value = 'The end must be after the start.'
    }
    return
  }

  if (strategy.value === 'recurring-interval') {
    const raw = intervalS.value.trim()
    const seconds = Number(raw)
    intervalError.value =
      raw === '' || !Number.isInteger(seconds) || seconds <= 0
        ? 'Enter a whole number of seconds greater than zero.'
        : null
    startAtError.value = startAt.value === '' ? 'Enter when the schedule starts.' : null
    validateOptionalTimes()
    return
  }

  if (strategy.value === 'recurring-weekday') {
    weekdaysError.value = weekdays.value.length === 0 ? 'Select at least one day.' : null
    startTimeError.value = startTime.value === '' ? 'Enter the start time.' : null
    endTimeError.value = endTime.value === '' ? 'Enter the end time.' : null
    if (
      startTimeError.value === null &&
      endTimeError.value === null &&
      startTime.value >= endTime.value
    ) {
      endTimeError.value = 'The end time must be after the start time.'
    }
    return
  }

  cronError.value = cronExpr.value.trim() === '' ? 'Enter a cron expression.' : null
  cronTzError.value = cronTz.value.trim() === '' ? 'Enter a timezone.' : null
  validateOptionalTimes()
}

function validate(): boolean {
  nameError.value = name.value.trim() === '' ? 'Enter a name for this window.' : null
  monitorError.value =
    scope.value === 'ids' && selectedMonitors.value.length === 0
      ? 'Select at least one monitor.'
      : null
  tagError.value =
    scope.value === 'tags' && selectedTags.value.length === 0 ? 'Select at least one tag.' : null
  startAtError.value = null
  endAtError.value = null
  intervalError.value = null
  startTimeError.value = null
  endTimeError.value = null
  weekdaysError.value = null
  cronError.value = null
  cronTzError.value = null

  validateStrategy()

  return (
    nameError.value === null &&
    monitorError.value === null &&
    tagError.value === null &&
    startAtError.value === null &&
    endAtError.value === null &&
    intervalError.value === null &&
    startTimeError.value === null &&
    endTimeError.value === null &&
    weekdaysError.value === null &&
    cronError.value === null &&
    cronTzError.value === null
  )
}

/** Empty values are sent as `null`; fields unused by the strategy are cleared. */
function buildInput(): MaintenanceWindowInput {
  const current = strategy.value
  const showsTimes =
    current === 'recurring-interval' || current === 'recurring-weekday' || current === 'cron'
  return {
    name: name.value.trim(),
    scope: scope.value,
    monitorIds: scope.value === 'ids' ? [...selectedMonitors.value] : [],
    tagIds: scope.value === 'tags' ? [...selectedTags.value] : [],
    strategy: current,
    startAt: current === 'single' || current === 'recurring-interval' ? toIso(startAt.value) : null,
    endAt: current === 'single' ? toIso(endAt.value) : null,
    intervalS: current === 'recurring-interval' ? Number(intervalS.value.trim()) : null,
    weekdays: current === 'recurring-weekday' ? [...weekdays.value] : [],
    startTime: showsTimes && startTime.value !== '' ? startTime.value : null,
    endTime: showsTimes && endTime.value !== '' ? endTime.value : null,
    cronExpr: current === 'cron' ? cronExpr.value.trim() : null,
    cronTz: current === 'cron' ? cronTz.value.trim() : null,
    active: active.value,
  }
}

async function submit(): Promise<void> {
  if (!validate()) return

  const input = buildInput()
  submitting.value = true
  formError.value = null
  try {
    const current = editing.value
    if (current === null) {
      await createMaintenanceWindow(input)
    } else {
      await updateMaintenanceWindow(current.id, input)
    }
    emit('saved')
    emit('close')
  } catch (error) {
    formError.value = errorMessage(error, 'Could not save the maintenance window.')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Modal
    :open="open"
    :title="isEdit ? 'Edit maintenance window' : 'Create maintenance window'"
    size="lg"
    :close-on-backdrop="!submitting"
    @close="emit('close')"
  >
    <form class="window-form" novalidate @submit.prevent="submit">
      <div class="form-grid">
        <Input
          v-model="name"
          label="Name"
          placeholder="Database upgrade"
          required
          :error="nameError"
        />
        <Select
          :model-value="scope"
          label="Applies to"
          :options="SCOPE_OPTIONS"
          @update:model-value="setScope"
        />
      </div>

      <Switch
        v-model="active"
        label="Active"
        hint="Inactive windows are kept but do not suppress alerts."
      />

      <fieldset v-if="scope === 'ids'" class="picker">
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
        <p v-if="monitorError !== null" class="form-error" role="alert">{{ monitorError }}</p>
      </fieldset>

      <fieldset v-if="scope === 'tags'" class="picker">
        <legend class="picker-title">Tags</legend>
        <p v-if="tags.length === 0" class="picker-empty">
          No tags available yet. Create a tag first.
        </p>
        <ul v-else class="picker-list">
          <li v-for="tag in tags" :key="tag.id">
            <label class="picker-row">
              <input type="checkbox" :checked="isTagSelected(tag.id)" @change="toggleTag(tag.id)" />
              <span>{{ tag.name }}</span>
            </label>
          </li>
        </ul>
        <p v-if="tagError !== null" class="form-error" role="alert">{{ tagError }}</p>
      </fieldset>

      <Select
        :model-value="strategy"
        label="Strategy"
        :options="STRATEGY_OPTIONS"
        @update:model-value="setStrategy"
      />

      <template v-if="strategy === 'single'">
        <div class="form-grid">
          <Input
            v-model="startAt"
            label="Starts"
            type="datetime-local"
            required
            :error="startAtError"
          />
          <Input v-model="endAt" label="Ends" type="datetime-local" required :error="endAtError" />
        </div>
      </template>

      <template v-else-if="strategy === 'recurring-interval'">
        <div class="form-grid">
          <Input
            v-model="intervalS"
            label="Repeat every (seconds)"
            type="number"
            :min="1"
            :step="1"
            required
            :error="intervalError"
          />
          <Input
            v-model="startAt"
            label="Active from"
            type="datetime-local"
            required
            :error="startAtError"
          />
        </div>
        <div class="form-grid">
          <Input v-model="startTime" label="Daily start" type="time" :error="startTimeError" />
          <Input v-model="endTime" label="Daily end" type="time" :error="endTimeError" />
        </div>
      </template>

      <template v-else-if="strategy === 'recurring-weekday'">
        <fieldset class="weekdays">
          <legend class="picker-title">Days</legend>
          <div class="weekday-row">
            <button
              v-for="day in WEEKDAYS"
              :key="day.value"
              type="button"
              class="weekday"
              :class="{ 'is-on': isWeekdaySelected(day.value) }"
              :aria-pressed="isWeekdaySelected(day.value)"
              :aria-label="day.label"
              @click="toggleWeekday(day.value)"
            >
              {{ day.short }}
            </button>
          </div>
          <p v-if="weekdaysError !== null" class="form-error" role="alert">{{ weekdaysError }}</p>
        </fieldset>

        <div class="form-grid">
          <Input
            v-model="startTime"
            label="Start time"
            type="time"
            required
            :error="startTimeError"
          />
          <Input v-model="endTime" label="End time" type="time" required :error="endTimeError" />
        </div>
      </template>

      <template v-else>
        <div class="form-grid">
          <Input
            v-model="cronExpr"
            label="Cron expression"
            placeholder="0 2 * * 6"
            hint="Five fields: minute, hour, day of month, month, weekday."
            mono
            required
            :error="cronError"
          />
          <Input
            v-model="cronTz"
            label="Timezone"
            placeholder="UTC"
            hint="IANA timezone, such as Europe/Lisbon."
            mono
            required
            :error="cronTzError"
          />
        </div>
        <div class="form-grid">
          <Input v-model="startTime" label="Window start" type="time" :error="startTimeError" />
          <Input v-model="endTime" label="Window end" type="time" :error="endTimeError" />
        </div>
      </template>

      <p v-if="formError !== null" class="form-error" role="alert">{{ formError }}</p>
    </form>

    <template #footer>
      <Button variant="secondary" :disabled="submitting" @click="emit('close')">Cancel</Button>
      <Button variant="primary" :loading="submitting" @click="submit">
        {{ isEdit ? 'Save window' : 'Create window' }}
      </Button>
    </template>
  </Modal>
</template>

<style scoped>
.window-form {
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
.weekdays {
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

.weekday-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.weekday {
  min-width: 44px;
  padding: 6px 10px;
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--muted);
  font: inherit;
  font-size: 12.5px;
  font-weight: 550;
  cursor: pointer;
}

.weekday:hover {
  color: var(--fg);
}

.weekday.is-on {
  background-color: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  color: var(--accent);
}

.form-error {
  color: var(--error);
  font-size: 13px;
}
</style>
