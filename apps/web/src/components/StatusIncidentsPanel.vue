<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  addStatusIncidentUpdate,
  createStatusIncident,
  errorMessage,
  fetchStatusIncidents,
  fetchStatusPages,
  updateStatusIncident,
} from '../api.js'
import type {
  StatusIncident,
  StatusIncidentImpact,
  StatusIncidentStatus,
  StatusPage,
} from '../api.js'
import {
  IMPACT_LEVELS,
  IMPACT_META,
  INCIDENT_STATUSES,
  INCIDENT_STATUS_META,
  SOURCE_LABELS,
} from '../statusDisplay.js'
import { formatDateTime, formatDuration, relativeTime } from '../format.js'
import Button from './ui/Button.vue'
import EmptyState from './ui/EmptyState.vue'
import Icon from './ui/Icon.vue'
import Input from './ui/Input.vue'
import Modal from './ui/Modal.vue'
import Select from './ui/Select.vue'
import Table from './ui/Table.vue'
import Textarea from './ui/Textarea.vue'
import Badge from './ui/Badge.vue'
import Card from './ui/Card.vue'
import type { TableColumn } from './ui/table.js'
import { useToast } from './ui/toast.js'

interface IncidentRow {
  incident: StatusIncident
  pageId: number
  pageLabel: string
}

const ALL_PAGES = ''

const toast = useToast()

const pages = ref<StatusPage[]>([])
const pageFilter = ref<string>(ALL_PAGES)
const rows = ref<IncidentRow[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)
const now = ref(Date.now())

const createOpen = ref(false)
const createPageId = ref<string>('')
const createTitle = ref('')
const createImpact = ref<StatusIncidentImpact>('major')
const createComponentIds = ref<string[]>([])
const createBody = ref('')
const createErrors = ref<{ page: string | null; title: string | null; body: string | null }>({
  page: null,
  title: null,
  body: null,
})
const creating = ref(false)
const createError = ref<string | null>(null)

const updateOpen = ref(false)
const updatingIncident = ref<StatusIncident | null>(null)
const updateStatus = ref<StatusIncidentStatus>('investigating')
const updateBody = ref('')
const updateError = ref<string | null>(null)
const updating = ref(false)

const editOpen = ref(false)
const editingRow = ref<IncidentRow | null>(null)
const editTitle = ref('')
const editImpact = ref<StatusIncidentImpact>('major')
const editComponentIds = ref<string[]>([])
const editTitleError = ref<string | null>(null)
const editError = ref<string | null>(null)
const savingEdit = ref(false)

const pageOptions = computed(() => [
  { value: ALL_PAGES, label: 'All pages' },
  ...pages.value.map((page) => ({ value: String(page.id), label: `${page.title} (${page.slug})` })),
])

const impactOptions = IMPACT_LEVELS.map((impact) => ({
  value: impact,
  label: IMPACT_META[impact].label,
}))

const statusOptions = INCIDENT_STATUSES.map((status) => ({
  value: status,
  label: INCIDENT_STATUS_META[status].label,
}))

/** Pages currently in scope: the filter selection or every page. */
const scopedPages = computed(() => {
  if (pageFilter.value === ALL_PAGES) return pages.value
  return pages.value.filter((page) => String(page.id) === pageFilter.value)
})

const pageById = computed(() => new Map(pages.value.map((page) => [page.id, page])))

function durationMs(incident: StatusIncident): number {
  const createdAt = Date.parse(incident.createdAt)
  if (Number.isNaN(createdAt)) return 0
  const end = incident.resolvedAt === null ? now.value : Date.parse(incident.resolvedAt)
  return Math.max(0, end - createdAt)
}

function componentLabel(page: StatusPage, componentId: string): string {
  for (const group of page.structure?.groups ?? []) {
    for (const component of group.components) {
      if (component.id === componentId) return component.label
    }
  }
  return componentId
}

function componentSummary(row: IncidentRow): string {
  const page = pageById.value.get(row.pageId)
  if (page === undefined || row.incident.componentIds.length === 0) return '—'
  return row.incident.componentIds.map((id) => componentLabel(page, id)).join(', ')
}

const columns: TableColumn<IncidentRow>[] = [
  {
    key: 'title',
    label: 'Incident',
    sortable: true,
    value: (row) => row.incident.title,
  },
  { key: 'page', label: 'Page', width: '150px', value: (row) => row.pageLabel },
  { key: 'status', label: 'Status', width: '120px', value: (row) => row.incident.status },
  { key: 'impact', label: 'Impact', width: '110px', value: (row) => row.incident.impact },
  {
    key: 'createdAt',
    label: 'Opened',
    sortable: true,
    width: '170px',
    value: (row) => Date.parse(row.incident.createdAt),
  },
  {
    key: 'duration',
    label: 'Duration',
    align: 'right',
    width: '110px',
    value: (row) => durationMs(row.incident),
  },
  { key: 'actions', label: '', align: 'right', width: '230px' },
]

async function loadPages(): Promise<boolean> {
  try {
    pages.value = await fetchStatusPages()
    return true
  } catch (error) {
    loadError.value = errorMessage(error, 'Could not load status pages.')
    loading.value = false
    return false
  }
}

async function loadIncidents(): Promise<void> {
  loading.value = true
  try {
    const scoped = scopedPages.value
    // The incident payload carries no page id, so attach it per request.
    const lists = await Promise.all(
      scoped.map(async (page) => {
        const incidents = await fetchStatusIncidents(page.id)
        return incidents.map<IncidentRow>((incident) => ({
          incident,
          pageId: page.id,
          pageLabel: page.title,
        }))
      }),
    )
    rows.value = lists
      .flat()
      .sort(
        (left, right) => Date.parse(right.incident.createdAt) - Date.parse(left.incident.createdAt),
      )
    now.value = Date.now()
    loadError.value = null
  } catch (error) {
    loadError.value = errorMessage(error, 'Could not load status incidents.')
  } finally {
    loading.value = false
  }
}

async function refresh(): Promise<void> {
  if (!(await loadPages())) return
  await loadIncidents()
}

function onPageFilterChange(value: string): void {
  pageFilter.value = value
  void loadIncidents()
}

/* Create */

function openCreate(): void {
  createPageId.value =
    pageFilter.value !== ALL_PAGES
      ? pageFilter.value
      : pages.value.length > 0
        ? String(pages.value[0]?.id ?? '')
        : ''
  createTitle.value = ''
  createImpact.value = 'major'
  createComponentIds.value = []
  createBody.value = ''
  createErrors.value = { page: null, title: null, body: null }
  createError.value = null
  createOpen.value = true
}

const createPage = computed(
  () => pages.value.find((page) => String(page.id) === createPageId.value) ?? null,
)

const createPageOptions = computed(() =>
  pageOptions.value.filter((option) => option.value !== ALL_PAGES),
)

function setCreateImpact(value: string): void {
  if (isImpact(value)) createImpact.value = value
}

function isImpact(value: string): value is StatusIncidentImpact {
  return IMPACT_LEVELS.includes(value as StatusIncidentImpact)
}

function setUpdateStatus(value: string): void {
  if (INCIDENT_STATUSES.includes(value as StatusIncidentStatus)) {
    updateStatus.value = value as StatusIncidentStatus
  }
}

/** Structure components of a page, offered when scoping an incident. */
function componentOptionsFor(pageId: number): { id: string; label: string; group: string }[] {
  const page = pageById.value.get(pageId)
  if (page === undefined) return []
  const options: { id: string; label: string; group: string }[] = []
  for (const group of page.structure?.groups ?? []) {
    for (const component of group.components) {
      options.push({ id: component.id, label: component.label, group: group.name })
    }
  }
  return options
}

/** Structure components of the page the incident is being opened on. */
const createComponentOptions = computed(() => {
  const page = createPage.value
  return page === null ? [] : componentOptionsFor(page.id)
})

function isCreateComponentSelected(id: string): boolean {
  return createComponentIds.value.includes(id)
}

function toggleCreateComponent(id: string): void {
  createComponentIds.value = isCreateComponentSelected(id)
    ? createComponentIds.value.filter((item) => item !== id)
    : [...createComponentIds.value, id]
}

async function submitCreate(): Promise<void> {
  const title = createTitle.value.trim()
  const body = createBody.value.trim()
  createErrors.value = {
    page: createPage.value === null ? 'Select a status page.' : null,
    title: title === '' ? 'Enter an incident title.' : null,
    body: body === '' ? 'Describe what is happening.' : null,
  }
  if (
    createErrors.value.page !== null ||
    createErrors.value.title !== null ||
    createErrors.value.body !== null
  ) {
    return
  }
  const page = createPage.value
  if (page === null) return

  creating.value = true
  createError.value = null
  try {
    await createStatusIncident(page.id, {
      title,
      impact: createImpact.value,
      componentIds: [...createComponentIds.value],
      body,
    })
    toast.success('Status incident opened', title)
    createOpen.value = false
    await loadIncidents()
  } catch (error) {
    createError.value = errorMessage(error, 'Could not open the incident.')
  } finally {
    creating.value = false
  }
}

/* Updates, resolve and field edits */

/** Opens the update timeline modal; `preset` preselects the update status. */
function openUpdate(row: IncidentRow, preset: StatusIncidentStatus | null = null): void {
  updatingIncident.value = row.incident
  updateStatus.value =
    preset ?? (row.incident.status === 'resolved' ? 'monitoring' : row.incident.status)
  updateBody.value = ''
  updateError.value = null
  updateOpen.value = true
}

/** Resolving posts a `resolved` update, so the admin narrates the closure. */
function resolve(row: IncidentRow): void {
  openUpdate(row, 'resolved')
}

async function submitUpdate(): Promise<void> {
  const incident = updatingIncident.value
  if (incident === null) return
  const body = updateBody.value.trim()
  if (body === '') {
    updateError.value = 'Describe the update.'
    return
  }
  updating.value = true
  updateError.value = null
  try {
    await addStatusIncidentUpdate(incident.id, { status: updateStatus.value, body })
    toast.success(
      updateStatus.value === 'resolved' ? 'Incident resolved' : 'Update posted',
      incident.title,
    )
    updateOpen.value = false
    await loadIncidents()
  } catch (error) {
    updateError.value = errorMessage(error, 'Could not post the update.')
  } finally {
    updating.value = false
  }
}

const editComponentOptions = computed(() => {
  const row = editingRow.value
  return row === null ? [] : componentOptionsFor(row.pageId)
})

function openEdit(row: IncidentRow): void {
  editingRow.value = row
  editTitle.value = row.incident.title
  editImpact.value = row.incident.impact
  editComponentIds.value = [...row.incident.componentIds]
  editTitleError.value = null
  editError.value = null
  editOpen.value = true
}

function setEditImpact(value: string): void {
  if (isImpact(value)) editImpact.value = value
}

function isEditComponentSelected(id: string): boolean {
  return editComponentIds.value.includes(id)
}

function toggleEditComponent(id: string): void {
  editComponentIds.value = isEditComponentSelected(id)
    ? editComponentIds.value.filter((item) => item !== id)
    : [...editComponentIds.value, id]
}

async function submitEdit(): Promise<void> {
  const row = editingRow.value
  if (row === null) return
  const title = editTitle.value.trim()
  editTitleError.value = title === '' ? 'Enter an incident title.' : null
  if (editTitleError.value !== null) return

  savingEdit.value = true
  editError.value = null
  try {
    await updateStatusIncident(row.incident.id, {
      title,
      impact: editImpact.value,
      componentIds: [...editComponentIds.value],
    })
    toast.success('Incident updated', title)
    editOpen.value = false
    await loadIncidents()
  } catch (error) {
    editError.value = errorMessage(error, 'Could not update the incident.')
  } finally {
    savingEdit.value = false
  }
}

onMounted(() => void refresh())
</script>

<template>
  <Card
    title="Status incidents"
    subtitle="Manual incident communication published on a status page."
    padding="none"
  >
    <template #actions>
      <Select
        class="page-filter"
        :model-value="pageFilter"
        label="Page"
        :options="pageOptions"
        @update:model-value="onPageFilterChange"
      />
      <Button variant="primary" size="sm" :disabled="pages.length === 0" @click="openCreate">
        <Icon name="plus" :size="14" />
        New incident
      </Button>
    </template>

    <p v-if="loadError !== null" class="banner" role="alert">{{ loadError }}</p>

    <EmptyState
      v-if="!loading && pages.length === 0"
      title="No status pages"
      description="Create a status page first, then communicate incidents from here."
    />

    <Table
      v-else
      :columns="columns"
      :rows="rows"
      :loading="loading"
      :row-key="(row) => row.incident.id"
    >
      <template #empty>
        <EmptyState
          title="No incidents"
          description="Manual incidents and auto-published monitor incidents appear here."
        />
      </template>

      <template #cell-title="{ row }">
        <div class="cell-stack">
          <span class="cell-strong">{{ row.incident.title }}</span>
          <span class="cell-muted">
            <Badge variant="neutral">{{ SOURCE_LABELS[row.incident.source] }}</Badge>
            <span v-if="row.incident.componentIds.length > 0">
              {{ componentSummary(row) }}
            </span>
          </span>
        </div>
      </template>

      <template #cell-status="{ row }">
        <Badge :variant="INCIDENT_STATUS_META[row.incident.status].variant" dot>
          {{ INCIDENT_STATUS_META[row.incident.status].label }}
        </Badge>
      </template>

      <template #cell-impact="{ row }">
        <Badge :variant="IMPACT_META[row.incident.impact].variant">
          {{ IMPACT_META[row.incident.impact].label }}
        </Badge>
      </template>

      <template #cell-createdAt="{ row }">
        <span class="tabular" :title="formatDateTime(row.incident.createdAt)">
          {{ relativeTime(row.incident.createdAt, now) }}
        </span>
      </template>

      <template #cell-duration="{ row }">
        <span class="tabular">{{ formatDuration(durationMs(row.incident)) }}</span>
      </template>

      <template #cell-actions="{ row }">
        <div class="row-actions">
          <Button variant="ghost" size="sm" @click="openEdit(row)">Edit</Button>
          <Button variant="ghost" size="sm" @click="openUpdate(row)">Update</Button>
          <Button
            v-if="row.incident.resolvedAt === null"
            variant="ghost"
            size="sm"
            @click="resolve(row)"
          >
            Resolve
          </Button>
          <span v-else class="muted-label">Resolved</span>
        </div>
      </template>
    </Table>
  </Card>

  <Modal
    :open="createOpen"
    title="New status incident"
    size="md"
    :close-on-backdrop="!creating"
    @close="createOpen = false"
  >
    <div class="stack-sm">
      <Select
        :model-value="createPageId"
        label="Status page"
        :options="createPageOptions"
        :error="createErrors.page"
        @update:model-value="createPageId = $event"
      />
      <Input
        v-model="createTitle"
        label="Title"
        placeholder="Elevated API error rates"
        required
        :error="createErrors.title"
      />
      <Select
        :model-value="createImpact"
        label="Impact"
        :options="impactOptions"
        @update:model-value="setCreateImpact"
      />
      <fieldset v-if="createComponentOptions.length > 0" class="picker">
        <legend class="picker-title">Components</legend>
        <ul class="picker-list">
          <li v-for="option in createComponentOptions" :key="option.id">
            <label class="picker-row">
              <input
                type="checkbox"
                :checked="isCreateComponentSelected(option.id)"
                @change="toggleCreateComponent(option.id)"
              />
              <span>{{ option.label }}</span>
              <span class="picker-group">{{ option.group }}</span>
            </label>
          </li>
        </ul>
      </fieldset>
      <Textarea
        v-model="createBody"
        label="First update"
        placeholder="We are investigating elevated error rates on the API."
        :rows="3"
        :error="createErrors.body"
      />
      <p v-if="createError !== null" class="form-error" role="alert">{{ createError }}</p>
    </div>

    <template #footer>
      <Button variant="secondary" :disabled="creating" @click="createOpen = false">Cancel</Button>
      <Button variant="primary" :loading="creating" @click="submitCreate">Open incident</Button>
    </template>
  </Modal>

  <Modal
    :open="updateOpen"
    title="Post update"
    size="sm"
    :close-on-backdrop="!updating"
    @close="updateOpen = false"
  >
    <div class="stack-sm">
      <p class="update-title">{{ updatingIncident?.title }}</p>
      <Select
        :model-value="updateStatus"
        label="Status"
        :options="statusOptions"
        @update:model-value="setUpdateStatus"
      />
      <Textarea
        v-model="updateBody"
        label="Message"
        placeholder="The fix is deployed and error rates are back to normal."
        :rows="3"
        :error="updateError"
      />
    </div>

    <template #footer>
      <Button variant="secondary" :disabled="updating" @click="updateOpen = false">Cancel</Button>
      <Button variant="primary" :loading="updating" @click="submitUpdate">Post update</Button>
    </template>
  </Modal>

  <Modal
    :open="editOpen"
    title="Edit incident"
    size="md"
    :close-on-backdrop="!savingEdit"
    @close="editOpen = false"
  >
    <div class="stack-sm">
      <Input v-model="editTitle" label="Title" required :error="editTitleError" />
      <Select
        :model-value="editImpact"
        label="Impact"
        :options="impactOptions"
        @update:model-value="setEditImpact"
      />
      <fieldset v-if="editComponentOptions.length > 0" class="picker">
        <legend class="picker-title">Components</legend>
        <ul class="picker-list">
          <li v-for="option in editComponentOptions" :key="option.id">
            <label class="picker-row">
              <input
                type="checkbox"
                :checked="isEditComponentSelected(option.id)"
                @change="toggleEditComponent(option.id)"
              />
              <span>{{ option.label }}</span>
              <span class="picker-group">{{ option.group }}</span>
            </label>
          </li>
        </ul>
      </fieldset>
      <p v-if="editError !== null" class="form-error" role="alert">{{ editError }}</p>
    </div>

    <template #footer>
      <Button variant="secondary" :disabled="savingEdit" @click="editOpen = false">Cancel</Button>
      <Button variant="primary" :loading="savingEdit" @click="submitEdit">Save incident</Button>
    </template>
  </Modal>
</template>

<style scoped>
.page-filter {
  min-width: 190px;
}

.banner {
  padding: var(--space-3) var(--space-4);
  background-color: var(--error-soft);
  color: var(--error);
  font-size: 13px;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.cell-strong {
  font-weight: 550;
}

.cell-muted {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--muted);
  font-size: 12px;
}

.muted-label {
  color: var(--muted);
  font-size: 12px;
}

.row-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-1);
}

.tabular {
  font-variant-numeric: tabular-nums;
}

.stack-sm {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.update-title {
  font-size: 13.5px;
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

.picker-title {
  padding: 0;
  color: var(--muted);
  font-size: 12px;
  font-weight: 550;
}

.picker-list {
  max-height: 160px;
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

.picker-group {
  color: var(--muted);
  font-size: 11.5px;
}

.form-error {
  color: var(--error);
  font-size: 12.5px;
}
</style>
