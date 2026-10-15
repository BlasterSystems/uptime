<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { deleteChannel, errorMessage, fetchChannels, testChannel } from '../api.js'
import type { Channel, ChannelType } from '../api.js'
import ChannelForm from '../components/ChannelForm.vue'
import Badge from '../components/ui/Badge.vue'
import Button from '../components/ui/Button.vue'
import ConfirmDialog from '../components/ui/ConfirmDialog.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import Icon from '../components/ui/Icon.vue'
import Table from '../components/ui/Table.vue'
import type { TableColumn } from '../components/ui/table.js'
import { useToast } from '../components/ui/toast.js'

const TYPE_LABELS: Record<ChannelType, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  email: 'Email',
  ntfy: 'ntfy',
  gotify: 'Gotify',
  webhook: 'Webhook',
}

const channels = ref<Channel[]>([])
const loadError = ref<string | null>(null)
const loadedOnce = ref(false)
const formOpen = ref(false)
const testingId = ref<number | null>(null)
const pendingDelete = ref<Channel | null>(null)
const deleting = ref(false)

const toast = useToast()

const columns: TableColumn<Channel>[] = [
  { key: 'name', label: 'Name', sortable: true },
  { key: 'type', label: 'Type', sortable: true, width: '140px' },
  { key: 'status', label: 'Status', width: '170px' },
  { key: 'actions', label: '', align: 'right', width: '190px' },
]

async function refresh(): Promise<void> {
  try {
    channels.value = await fetchChannels()
    loadError.value = null
  } catch (error) {
    loadError.value = errorMessage(error, 'Could not load notification channels.')
  } finally {
    loadedOnce.value = true
  }
}

async function runTest(channel: Channel): Promise<void> {
  testingId.value = channel.id
  try {
    await testChannel(channel.id)
    toast.success('Test notification sent', channel.name)
  } catch (error) {
    toast.error('Test failed', errorMessage(error, 'The channel rejected the test notification.'))
  } finally {
    testingId.value = null
  }
}

async function confirmDelete(): Promise<void> {
  if (pendingDelete.value === null) return
  const channel = pendingDelete.value
  deleting.value = true
  try {
    await deleteChannel(channel.id)
    toast.success('Channel deleted', channel.name)
    pendingDelete.value = null
    await refresh()
  } catch (error) {
    toast.error('Could not delete the channel', errorMessage(error, 'Try again.'))
  } finally {
    deleting.value = false
  }
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <div class="view">
    <section class="panel">
      <header class="panel-head">
        <div>
          <h2 class="panel-title">Notification channels</h2>
          <p class="panel-note">
            Credentials are write-only: the API never returns channel configuration.
          </p>
        </div>
        <Button variant="primary" @click="formOpen = true">
          <Icon name="plus" :size="14" />
          Add channel
        </Button>
      </header>

      <p v-if="loadError !== null" class="banner" role="alert">{{ loadError }}</p>

      <Table :columns="columns" :rows="channels" :loading="!loadedOnce" :row-key="(row) => row.id">
        <template #empty>
          <EmptyState
            title="No notification channels"
            description="Add Telegram, Slack, email or webhook delivery so incidents reach the on-call team."
          >
            <template #icon><Icon name="notifications" :size="18" /></template>
            <template #actions>
              <Button variant="primary" @click="formOpen = true">Add channel</Button>
            </template>
          </EmptyState>
        </template>

        <template #cell-name="{ row }">
          <span class="cell-strong">{{ row.name }}</span>
        </template>

        <template #cell-type="{ row }">
          <Badge variant="neutral" mono>{{ row.type }}</Badge>
        </template>

        <template #cell-status="{ row }">
          <div class="badge-row">
            <Badge :variant="row.active ? 'success' : 'warning'" dot>
              {{ row.active ? 'Active' : 'Inactive' }}
            </Badge>
            <Badge v-if="row.isDefault" variant="accent">Default</Badge>
          </div>
        </template>

        <template #cell-actions="{ row }">
          <div class="row-actions">
            <Button
              variant="secondary"
              size="sm"
              :loading="testingId === row.id"
              :aria-label="`Send test notification to ${row.name}`"
              @click="runTest(row)"
            >
              Test
            </Button>
            <Button
              variant="ghost"
              size="sm"
              :aria-label="`Delete channel ${row.name}`"
              @click="pendingDelete = row"
            >
              Delete
            </Button>
          </div>
        </template>
      </Table>
    </section>

    <p class="hint">
      Incident notifications fan out to the channels assigned to a monitor, or to the default
      channels when a monitor has none.
    </p>

    <ChannelForm :open="formOpen" @created="refresh" @close="formOpen = false" />

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete channel"
      :message="
        pendingDelete === null
          ? undefined
          : `“${pendingDelete.name}” will stop receiving incident notifications.`
      "
      confirm-label="Delete channel"
      danger
      :loading="deleting"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.panel {
  overflow: hidden;
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.panel-title {
  font-size: 15px;
  font-weight: 600;
}

.panel-note {
  margin-top: 2px;
  color: var(--muted);
  font-size: 12.5px;
}

.cell-strong {
  font-weight: 500;
}

.badge-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.banner {
  padding: var(--space-3) var(--space-4);
  background-color: var(--error-soft);
  border-bottom: 1px solid color-mix(in srgb, var(--error) 40%, transparent);
  color: var(--thread-ink);
  font-size: 13px;
}

.hint {
  color: var(--muted);
  font-size: 12.5px;
}
</style>
