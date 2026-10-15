<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  createStatusSubscription,
  deleteStatusSubscription,
  errorMessage,
  fetchChannels,
  fetchStatusPages,
  fetchStatusSubscriptions,
  testStatusSubscription,
} from '../api.js'
import type { Channel, StatusPage, StatusSubscription, StatusSubscriptionEvent } from '../api.js'
import { SUBSCRIPTION_EVENT_LABELS, SUBSCRIPTION_EVENTS } from '../statusDisplay.js'
import { formatDateTime } from '../format.js'
import Badge from './ui/Badge.vue'
import Button from './ui/Button.vue'
import Card from './ui/Card.vue'
import ConfirmDialog from './ui/ConfirmDialog.vue'
import EmptyState from './ui/EmptyState.vue'
import Icon from './ui/Icon.vue'
import Modal from './ui/Modal.vue'
import Select from './ui/Select.vue'
import Table from './ui/Table.vue'
import type { TableColumn } from './ui/table.js'
import { useToast } from './ui/toast.js'

const DEFAULT_EVENTS: StatusSubscriptionEvent[] = [
  'incident_open',
  'incident_update',
  'incident_resolved',
]

const toast = useToast()

const pages = ref<StatusPage[]>([])
const channels = ref<Channel[]>([])
const pageId = ref<string>('')
const subscriptions = ref<StatusSubscription[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)

const createOpen = ref(false)
const createChannelId = ref<string>('')
const createComponentIds = ref<string[]>([])
const createEvents = ref<StatusSubscriptionEvent[]>([...DEFAULT_EVENTS])
const createErrors = ref<{ channel: string | null; events: string | null }>({
  channel: null,
  events: null,
})
const creating = ref(false)
const createError = ref<string | null>(null)

const testing = ref<number | null>(null)
const pendingDelete = ref<StatusSubscription | null>(null)
const deleting = ref(false)

const pageOptions = computed(() =>
  pages.value.map((page) => ({ value: String(page.id), label: `${page.title} (${page.slug})` })),
)

const channelOptions = computed(() =>
  channels.value.map((channel) => ({
    value: String(channel.id),
    label: `${channel.name} · ${channel.type}`,
  })),
)

const selectedPage = computed(
  () => pages.value.find((page) => String(page.id) === pageId.value) ?? null,
)

const channelById = computed(() => new Map(channels.value.map((channel) => [channel.id, channel])))

/** Structure components of the selected page, offered as subscription scopes. */
const componentOptions = computed(() => {
  const page = selectedPage.value
  if (page === null) return []
  const options: { id: string; label: string; group: string }[] = []
  for (const group of page.structure?.groups ?? []) {
    for (const component of group.components) {
      options.push({ id: component.id, label: component.label, group: group.name })
    }
  }
  return options
})

const columns: TableColumn<StatusSubscription>[] = [
  {
    key: 'channel',
    label: 'Channel',
    value: (row) => channelName(row),
  },
  { key: 'components', label: 'Components' },
  { key: 'events', label: 'Events' },
  {
    key: 'createdAt',
    label: 'Created',
    sortable: true,
    width: '170px',
    value: (row) => Date.parse(row.createdAt),
  },
  { key: 'actions', label: '', align: 'right', width: '160px' },
]

/** Channel label from the server's join, falling back to the loaded channel list. */
function channelName(row: StatusSubscription): string {
  if (row.channelName !== null && row.channelName !== '') return row.channelName
  return channelById.value.get(row.channelId)?.name ?? `#${row.channelId}`
}

function channelType(row: StatusSubscription): string | null {
  return row.channelType ?? channelById.value.get(row.channelId)?.type ?? null
}

function componentSummary(row: StatusSubscription): string {
  if (row.componentIds.length === 0) return 'Whole page'
  const page = selectedPage.value
  if (page === null) return row.componentIds.join(', ')
  const labels = row.componentIds.map((id) => {
    for (const group of page.structure?.groups ?? []) {
      for (const component of group.components) {
        if (component.id === id) return component.label
      }
    }
    return id
  })
  return labels.join(', ')
}

async function loadBase(): Promise<void> {
  try {
    const [pageList, channelList] = await Promise.all([fetchStatusPages(), fetchChannels()])
    pages.value = pageList
    channels.value = channelList
    if (pageId.value === '' && pageList.length > 0) {
      pageId.value = String(pageList[0]?.id ?? '')
    }
  } catch (error) {
    loadError.value = errorMessage(error, 'Could not load status pages or channels.')
    loading.value = false
  }
}

async function loadSubscriptions(): Promise<void> {
  if (pageId.value === '') {
    subscriptions.value = []
    loading.value = false
    return
  }
  loading.value = true
  try {
    subscriptions.value = await fetchStatusSubscriptions(Number(pageId.value))
    loadError.value = null
  } catch (error) {
    loadError.value = errorMessage(error, 'Could not load subscriptions.')
  } finally {
    loading.value = false
  }
}

function onPageChange(value: string): void {
  pageId.value = value
}

watch(pageId, () => void loadSubscriptions())

/* Create */

function openCreate(): void {
  createChannelId.value = channels.value.length > 0 ? String(channels.value[0]?.id ?? '') : ''
  createComponentIds.value = []
  createEvents.value = [...DEFAULT_EVENTS]
  createErrors.value = { channel: null, events: null }
  createError.value = null
  createOpen.value = true
}

function isComponentSelected(id: string): boolean {
  return createComponentIds.value.includes(id)
}

function toggleComponent(id: string): void {
  createComponentIds.value = isComponentSelected(id)
    ? createComponentIds.value.filter((item) => item !== id)
    : [...createComponentIds.value, id]
}

function isEventSelected(event: StatusSubscriptionEvent): boolean {
  return createEvents.value.includes(event)
}

function toggleEvent(event: StatusSubscriptionEvent): void {
  createEvents.value = isEventSelected(event)
    ? createEvents.value.filter((item) => item !== event)
    : [...createEvents.value, event]
}

async function submitCreate(): Promise<void> {
  createErrors.value = {
    channel: createChannelId.value === '' ? 'Select a channel.' : null,
    events: createEvents.value.length === 0 ? 'Select at least one event.' : null,
  }
  if (createErrors.value.channel !== null || createErrors.value.events !== null) return
  if (pageId.value === '') return

  creating.value = true
  createError.value = null
  try {
    await createStatusSubscription(Number(pageId.value), {
      channelId: Number(createChannelId.value),
      componentIds: [...createComponentIds.value],
      events: [...createEvents.value],
    })
    toast.success('Subscription created')
    createOpen.value = false
    await loadSubscriptions()
  } catch (error) {
    createError.value = errorMessage(error, 'Could not create the subscription.')
  } finally {
    creating.value = false
  }
}

/* Test and delete */

async function test(row: StatusSubscription): Promise<void> {
  testing.value = row.id
  try {
    await testStatusSubscription(row.id)
    toast.success('Test notification sent', channelName(row))
  } catch (error) {
    toast.error('Could not send the test notification', errorMessage(error, 'Try again.'))
  } finally {
    testing.value = null
  }
}

async function confirmDelete(): Promise<void> {
  const subscription = pendingDelete.value
  if (subscription === null) return
  deleting.value = true
  try {
    await deleteStatusSubscription(subscription.id)
    toast.success('Subscription deleted', channelName(subscription))
    pendingDelete.value = null
    await loadSubscriptions()
  } catch (error) {
    toast.error('Could not delete the subscription', errorMessage(error, 'Try again.'))
  } finally {
    deleting.value = false
  }
}

onMounted(async () => {
  await loadBase()
  await loadSubscriptions()
})
</script>

<template>
  <Card
    title="Subscriptions"
    subtitle="Notification channels that follow a page's incidents and maintenance."
    padding="none"
  >
    <template #actions>
      <Select
        class="page-filter"
        :model-value="pageId"
        label="Page"
        :options="pageOptions"
        :disabled="pages.length === 0"
        @update:model-value="onPageChange"
      />
      <Button
        variant="primary"
        size="sm"
        :disabled="pages.length === 0 || channels.length === 0"
        @click="openCreate"
      >
        <Icon name="plus" :size="14" />
        Add subscription
      </Button>
    </template>

    <p v-if="loadError !== null" class="banner" role="alert">{{ loadError }}</p>

    <EmptyState
      v-if="!loading && pages.length === 0"
      title="No status pages"
      description="Create a status page first, then subscribe channels to it."
    />

    <EmptyState
      v-else-if="!loading && channels.length === 0"
      title="No notification channels"
      description="Add a notification channel, then subscribe it to a status page."
    />

    <Table
      v-else
      :columns="columns"
      :rows="subscriptions"
      :loading="loading"
      :row-key="(row) => row.id"
    >
      <template #empty>
        <EmptyState
          title="No subscriptions"
          description="Subscribe a channel to get notified when this page changes."
        />
      </template>

      <template #cell-channel="{ row }">
        <div class="cell-stack">
          <span class="cell-strong">{{ channelName(row) }}</span>
          <Badge v-if="channelType(row) !== null" variant="neutral" mono>
            {{ channelType(row) }}
          </Badge>
        </div>
      </template>

      <template #cell-components="{ row }">
        <span class="cell-muted">{{ componentSummary(row) }}</span>
      </template>

      <template #cell-events="{ row }">
        <div class="badge-row">
          <Badge v-for="event in row.events" :key="event" variant="neutral">
            {{ SUBSCRIPTION_EVENT_LABELS[event] }}
          </Badge>
        </div>
      </template>

      <template #cell-createdAt="{ row }">
        <span class="tabular">{{ formatDateTime(row.createdAt) }}</span>
      </template>

      <template #cell-actions="{ row }">
        <div class="row-actions">
          <Button variant="ghost" size="sm" :loading="testing === row.id" @click="test(row)">
            Test
          </Button>
          <Button variant="ghost" size="sm" @click="pendingDelete = row">Delete</Button>
        </div>
      </template>
    </Table>
  </Card>

  <Modal
    :open="createOpen"
    title="Add subscription"
    size="md"
    :close-on-backdrop="!creating"
    @close="createOpen = false"
  >
    <div class="stack-sm">
      <Select
        :model-value="createChannelId"
        label="Channel"
        :options="channelOptions"
        :error="createErrors.channel"
        @update:model-value="createChannelId = $event"
      />

      <fieldset class="picker">
        <legend class="picker-title">Components</legend>
        <p class="picker-hint">Leave every component unselected to follow the whole page.</p>
        <p v-if="componentOptions.length === 0" class="picker-empty">
          This page has no components yet.
        </p>
        <ul v-else class="picker-list">
          <li v-for="option in componentOptions" :key="option.id">
            <label class="picker-row">
              <input
                type="checkbox"
                :checked="isComponentSelected(option.id)"
                @change="toggleComponent(option.id)"
              />
              <span>{{ option.label }}</span>
              <span class="picker-group">{{ option.group }}</span>
            </label>
          </li>
        </ul>
      </fieldset>

      <fieldset class="picker">
        <legend class="picker-title">Events</legend>
        <div class="event-list">
          <label v-for="event in SUBSCRIPTION_EVENTS" :key="event" class="picker-row">
            <input type="checkbox" :checked="isEventSelected(event)" @change="toggleEvent(event)" />
            <span>{{ SUBSCRIPTION_EVENT_LABELS[event] }}</span>
          </label>
        </div>
        <p v-if="createErrors.events !== null" class="form-error" role="alert">
          {{ createErrors.events }}
        </p>
      </fieldset>

      <p v-if="createError !== null" class="form-error" role="alert">{{ createError }}</p>
    </div>

    <template #footer>
      <Button variant="secondary" :disabled="creating" @click="createOpen = false">Cancel</Button>
      <Button variant="primary" :loading="creating" @click="submitCreate">Subscribe</Button>
    </template>
  </Modal>

  <ConfirmDialog
    :open="pendingDelete !== null"
    title="Delete subscription"
    :message="
      pendingDelete === null
        ? undefined
        : `“${channelName(pendingDelete)}” stops receiving updates for this page.`
    "
    confirm-label="Delete subscription"
    danger
    :loading="deleting"
    @confirm="confirmDelete"
    @cancel="pendingDelete = null"
  />
</template>

<style scoped>
.page-filter {
  min-width: 190px;
}

.banner {
  padding: var(--space-3) var(--space-4);
  background-color: var(--error-soft);
  color: var(--thread-ink);
  font-size: 13px;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
}

.cell-strong {
  font-weight: 500;
}

.cell-muted {
  color: var(--muted);
  font-size: 12px;
}

.badge-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
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
  font-weight: 500;
}

.picker-hint {
  color: var(--muted);
  font-size: 12px;
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

.picker-empty {
  padding: var(--space-3);
  background-color: var(--surface-2);
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 12.5px;
}

.event-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.form-error {
  color: var(--thread-ink);
  font-size: 12.5px;
}
</style>
