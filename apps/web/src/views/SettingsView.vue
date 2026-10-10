<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import {
  API_KEY_SCOPES,
  ApiError,
  createApiKey,
  deleteApiKey,
  disableTotp,
  errorMessage,
  fetchApiKeys,
  startTotpSetup,
  verifyTotpSetup,
} from '../api.js'
import type { ApiKey, ApiKeyScope } from '../api.js'
import { useAuth } from '../auth.js'
import { copyText } from '../clipboard.js'
import { formatDateTime } from '../format.js'
import Badge from '../components/ui/Badge.vue'
import Button from '../components/ui/Button.vue'
import Card from '../components/ui/Card.vue'
import ConfirmDialog from '../components/ui/ConfirmDialog.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import Icon from '../components/ui/Icon.vue'
import Input from '../components/ui/Input.vue'
import Modal from '../components/ui/Modal.vue'
import Switch from '../components/ui/Switch.vue'
import Table from '../components/ui/Table.vue'
import Tabs from '../components/ui/Tabs.vue'
import type { TableColumn } from '../components/ui/table.js'
import { useToast } from '../components/ui/toast.js'

type TwoFactorMode = 'idle' | 'setup' | 'enabled'

const SCOPE_HINTS: Record<ApiKeyScope, string> = {
  read: 'Read monitors, incidents and heartbeats.',
  write: 'Create and update monitors.',
  admin: 'Manage channels, tags and API keys.',
}

const TABS = [
  { id: 'profile', label: 'Profile' },
  { id: 'security', label: 'Security' },
  { id: 'api-keys', label: 'API keys' },
] as const

const { state, isAdmin } = useAuth()
const toast = useToast()

const tab = ref<string>('profile')

/* Two-factor authentication */

const twoFactorMode = ref<TwoFactorMode>('idle')
const twoFactorBusy = ref(false)
const secret = ref<string | null>(null)
const otpauthUrl = ref<string | null>(null)
const otp = ref('')
const otpError = ref<string | null>(null)
const recoveryCodes = ref<string[]>([])
const disablePassword = ref('')
const disableError = ref<string | null>(null)

async function beginSetup(): Promise<void> {
  twoFactorBusy.value = true
  otpError.value = null
  try {
    const setup = await startTotpSetup()
    secret.value = setup.secret
    otpauthUrl.value = setup.otpauthUrl
    twoFactorMode.value = 'setup'
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      twoFactorMode.value = 'enabled'
      toast.info('Two-factor authentication is already enabled')
      return
    }
    toast.error('Could not start two-factor setup', errorMessage(error, 'Try again.'))
  } finally {
    twoFactorBusy.value = false
  }
}

async function verifyOtp(): Promise<void> {
  const code = otp.value.trim()
  if (!/^\d{6}$/.test(code)) {
    otpError.value = 'Enter the 6-digit code from your authenticator app.'
    return
  }
  twoFactorBusy.value = true
  otpError.value = null
  try {
    recoveryCodes.value = await verifyTotpSetup(code)
    otp.value = ''
    twoFactorMode.value = 'enabled'
    toast.success('Two-factor authentication enabled', 'Store the recovery codes safely.')
  } catch (error) {
    otpError.value = errorMessage(error, 'That code is not valid. Try again.')
  } finally {
    twoFactorBusy.value = false
  }
}

async function disableTwoFactor(): Promise<void> {
  if (disablePassword.value === '') {
    disableError.value = 'Enter your password to confirm.'
    return
  }
  twoFactorBusy.value = true
  disableError.value = null
  try {
    await disableTotp(disablePassword.value)
    disablePassword.value = ''
    recoveryCodes.value = []
    secret.value = null
    otpauthUrl.value = null
    twoFactorMode.value = 'idle'
    toast.success('Two-factor authentication disabled')
  } catch (error) {
    disableError.value = errorMessage(error, 'Could not disable two-factor authentication.')
  } finally {
    twoFactorBusy.value = false
  }
}

/* API keys */

const apiKeys = ref<ApiKey[]>([])
const keysLoaded = ref(false)
const keysError = ref<string | null>(null)
const createKeyOpen = ref(false)
const newKeyName = ref('')
const newKeyNameError = ref<string | null>(null)
const newKeyScopes = ref<ApiKeyScope[]>(['read'])
const newKeyScopesError = ref<string | null>(null)
const newKeyValue = ref<string | null>(null)
const creatingKey = ref(false)
const createKeyError = ref<string | null>(null)
const pendingKeyDelete = ref<ApiKey | null>(null)
const deletingKey = ref(false)

const keyColumns: TableColumn<ApiKey>[] = [
  { key: 'name', label: 'Name', sortable: true },
  { key: 'scopes', label: 'Scopes', width: '210px' },
  { key: 'createdAt', label: 'Created', sortable: true, width: '170px' },
  { key: 'lastUsedAt', label: 'Last used', sortable: true, width: '170px' },
  { key: 'actions', label: '', align: 'right', width: '110px' },
]

async function loadApiKeys(): Promise<void> {
  try {
    apiKeys.value = await fetchApiKeys()
    keysError.value = null
  } catch (error) {
    keysError.value = errorMessage(error, 'Could not load API keys.')
  } finally {
    keysLoaded.value = true
  }
}

function resetKeyForm(): void {
  newKeyName.value = ''
  newKeyNameError.value = null
  newKeyScopes.value = ['read']
  newKeyScopesError.value = null
  newKeyValue.value = null
  createKeyError.value = null
}

function openKeyForm(): void {
  resetKeyForm()
  createKeyOpen.value = true
}

function closeKeyForm(): void {
  createKeyOpen.value = false
  resetKeyForm()
}

function isScopeSelected(scope: ApiKeyScope): boolean {
  return newKeyScopes.value.includes(scope)
}

function toggleScope(scope: ApiKeyScope): void {
  newKeyScopes.value = isScopeSelected(scope)
    ? newKeyScopes.value.filter((item) => item !== scope)
    : [...newKeyScopes.value, scope]
}

async function submitKey(): Promise<void> {
  const name = newKeyName.value.trim()
  newKeyNameError.value = name === '' ? 'Enter a name for this key.' : null
  newKeyScopesError.value = newKeyScopes.value.length === 0 ? 'Select at least one scope.' : null
  if (newKeyNameError.value !== null || newKeyScopesError.value !== null) return

  creatingKey.value = true
  createKeyError.value = null
  try {
    newKeyValue.value = await createApiKey(name, newKeyScopes.value)
    toast.success('API key created', 'Copy it now — it is shown only once.')
    await loadApiKeys()
  } catch (error) {
    createKeyError.value = errorMessage(error, 'Could not create the API key.')
  } finally {
    creatingKey.value = false
  }
}

async function confirmKeyDelete(): Promise<void> {
  if (pendingKeyDelete.value === null) return
  const key = pendingKeyDelete.value
  deletingKey.value = true
  try {
    await deleteApiKey(key.id)
    toast.success('API key deleted', key.name)
    pendingKeyDelete.value = null
    await loadApiKeys()
  } catch (error) {
    toast.error('Could not delete the API key', errorMessage(error, 'Try again.'))
  } finally {
    deletingKey.value = false
  }
}

/* Shared */

async function copyToClipboard(text: string, label: string): Promise<void> {
  if (await copyText(text)) {
    toast.success(`${label} copied`)
    return
  }
  toast.error('Copy failed', 'Select the value and copy it manually.')
}

watch(tab, (value) => {
  if (value === 'api-keys' && isAdmin.value && !keysLoaded.value) void loadApiKeys()
})

onMounted(() => {
  if (isAdmin.value) void loadApiKeys()
})
</script>

<template>
  <div class="view">
    <Tabs v-model="tab" :tabs="TABS">
      <template #tab-profile>
        <div class="stack">
          <Card title="Account" subtitle="Your sign-in identity and role.">
            <div class="form-grid">
              <Input :model-value="state.user?.email ?? ''" label="Email" readonly />
              <Input :model-value="state.user?.role ?? ''" label="Role" readonly />
            </div>
          </Card>

          <Card title="Password" subtitle="Password changes are not available in this release.">
            <div class="form-grid">
              <Input
                :model-value="''"
                label="New password"
                type="password"
                disabled
                hint="Coming in a later release."
              />
              <Input :model-value="''" label="Confirm password" type="password" disabled />
            </div>
            <template #footer>
              <Button variant="primary" disabled>Change password</Button>
            </template>
          </Card>
        </div>
      </template>

      <template #tab-security>
        <div class="stack">
          <Card title="Two-factor authentication">
            <template v-if="twoFactorMode === 'idle'">
              <p class="text-note">
                Add a second factor from any TOTP authenticator app. Sign-in then requires a
                one-time code in addition to your password.
              </p>
            </template>

            <template v-else-if="twoFactorMode === 'setup'">
              <div class="stack-sm">
                <p class="text-note">
                  Add the secret to your authenticator, then confirm the generated code.
                </p>
                <div class="copy-row">
                  <code class="copy-value mono">{{ secret }}</code>
                  <Button
                    variant="secondary"
                    size="sm"
                    @click="copyToClipboard(secret ?? '', 'Secret')"
                  >
                    <Icon name="copy" :size="14" />
                    Copy
                  </Button>
                </div>
                <div class="copy-row">
                  <code class="copy-value mono">{{ otpauthUrl }}</code>
                  <Button
                    variant="secondary"
                    size="sm"
                    @click="copyToClipboard(otpauthUrl ?? '', 'Setup link')"
                  >
                    <Icon name="copy" :size="14" />
                    Copy
                  </Button>
                </div>
                <Input
                  v-model="otp"
                  label="Verification code"
                  placeholder="123456"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  :error="otpError"
                />
              </div>
            </template>

            <template v-else>
              <div class="stack-sm">
                <p class="status-line">
                  <Badge variant="success" dot>Enabled</Badge>
                  <span class="text-note">Sign-in requires a one-time code.</span>
                </p>

                <div v-if="recoveryCodes.length > 0" class="recovery">
                  <div class="recovery-head">
                    <p class="recovery-title">Recovery codes</p>
                    <Button
                      variant="secondary"
                      size="sm"
                      @click="copyToClipboard(recoveryCodes.join('\n'), 'Recovery codes')"
                    >
                      <Icon name="copy" :size="14" />
                      Copy all
                    </Button>
                  </div>
                  <ul class="recovery-list">
                    <li v-for="code in recoveryCodes" :key="code" class="mono">{{ code }}</li>
                  </ul>
                  <p class="text-note">
                    Each code signs you in once if you lose your authenticator. Store them offline.
                  </p>
                </div>

                <Input
                  v-model="disablePassword"
                  label="Confirm password to disable"
                  type="password"
                  autocomplete="current-password"
                  :error="disableError"
                />
              </div>
            </template>

            <template #footer>
              <template v-if="twoFactorMode === 'idle'">
                <Button variant="primary" :loading="twoFactorBusy" @click="beginSetup">
                  Begin setup
                </Button>
              </template>
              <template v-else-if="twoFactorMode === 'setup'">
                <Button
                  variant="secondary"
                  :disabled="twoFactorBusy"
                  @click="twoFactorMode = 'idle'"
                >
                  Cancel
                </Button>
                <Button variant="primary" :loading="twoFactorBusy" @click="verifyOtp">
                  Verify and enable
                </Button>
              </template>
              <template v-else>
                <Button variant="danger" :loading="twoFactorBusy" @click="disableTwoFactor">
                  Disable two-factor
                </Button>
              </template>
            </template>
          </Card>
        </div>
      </template>

      <template #tab-api-keys>
        <EmptyState
          v-if="!isAdmin"
          title="Administrator role required"
          description="Only administrators can create and revoke API keys."
        >
          <template #icon><Icon name="settings" :size="18" /></template>
        </EmptyState>

        <Card
          v-else
          title="API keys"
          subtitle="Bearer tokens for scripts and integrations."
          padding="none"
        >
          <template #actions>
            <Button variant="primary" size="sm" @click="openKeyForm">
              <Icon name="plus" :size="14" />
              Create key
            </Button>
          </template>

          <p v-if="keysError !== null" class="banner" role="alert">{{ keysError }}</p>

          <Table
            :columns="keyColumns"
            :rows="apiKeys"
            :loading="!keysLoaded"
            :row-key="(row) => row.id"
          >
            <template #empty>
              <EmptyState
                title="No API keys"
                description="Create a key to let external tooling read monitors over the API."
              />
            </template>

            <template #cell-name="{ row }">
              <span class="cell-strong">{{ row.name }}</span>
            </template>

            <template #cell-scopes="{ row }">
              <div class="badge-row">
                <Badge v-for="scope in row.scopes" :key="scope" variant="neutral" mono>
                  {{ scope }}
                </Badge>
              </div>
            </template>

            <template #cell-createdAt="{ row }">
              <span class="tabular">{{ formatDateTime(row.createdAt) }}</span>
            </template>

            <template #cell-lastUsedAt="{ row }">
              <span v-if="row.lastUsedAt !== null" class="tabular">
                {{ formatDateTime(row.lastUsedAt) }}
              </span>
              <span v-else class="muted">Never</span>
            </template>

            <template #cell-actions="{ row }">
              <Button
                variant="ghost"
                size="sm"
                :aria-label="`Delete API key ${row.name}`"
                @click="pendingKeyDelete = row"
              >
                Delete
              </Button>
            </template>
          </Table>
        </Card>
      </template>
    </Tabs>

    <Modal
      :open="createKeyOpen"
      :title="newKeyValue === null ? 'Create API key' : 'API key created'"
      size="sm"
      :close-on-backdrop="newKeyValue === null"
      @close="closeKeyForm"
    >
      <div v-if="newKeyValue === null" class="stack-sm">
        <Input v-model="newKeyName" label="Name" placeholder="ci-deploy" :error="newKeyNameError" />
        <div class="scopes">
          <Switch
            v-for="scope in API_KEY_SCOPES"
            :key="scope"
            :model-value="isScopeSelected(scope)"
            :label="scope"
            :hint="SCOPE_HINTS[scope]"
            @update:model-value="toggleScope(scope)"
          />
        </div>
        <p v-if="newKeyScopesError !== null" class="form-error" role="alert">
          {{ newKeyScopesError }}
        </p>
        <p v-if="createKeyError !== null" class="form-error" role="alert">{{ createKeyError }}</p>
      </div>

      <div v-else class="stack-sm">
        <p class="text-note">This is the only time the key is shown. Copy it now.</p>
        <div class="copy-row">
          <code class="copy-value mono">{{ newKeyValue }}</code>
          <Button variant="secondary" size="sm" @click="copyToClipboard(newKeyValue, 'API key')">
            <Icon name="copy" :size="14" />
            Copy
          </Button>
        </div>
      </div>

      <template #footer>
        <template v-if="newKeyValue === null">
          <Button variant="secondary" :disabled="creatingKey" @click="closeKeyForm">Cancel</Button>
          <Button variant="primary" :loading="creatingKey" @click="submitKey">Create key</Button>
        </template>
        <template v-else>
          <Button variant="primary" @click="closeKeyForm">Done</Button>
        </template>
      </template>
    </Modal>

    <ConfirmDialog
      :open="pendingKeyDelete !== null"
      title="Delete API key"
      :message="
        pendingKeyDelete === null
          ? undefined
          : `“${pendingKeyDelete.name}” stops working immediately. This cannot be undone.`
      "
      confirm-label="Delete key"
      danger
      :loading="deletingKey"
      @confirm="confirmKeyDelete"
      @cancel="pendingKeyDelete = null"
    />
  </div>
</template>

<style scoped>
.view {
  min-width: 0;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.stack-sm {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-4);
}

.text-note {
  color: var(--muted);
  font-size: 13px;
}

.status-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
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

.recovery {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.recovery-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.recovery-title {
  font-size: 13px;
  font-weight: 600;
}

.recovery-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: var(--space-1) var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.recovery-list li {
  padding: 2px 0;
}

.scopes {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.badge-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
}

.cell-strong {
  font-weight: 550;
}

.tabular {
  font-variant-numeric: tabular-nums;
}

.banner {
  padding: var(--space-3) var(--space-4);
  background-color: var(--error-soft);
  color: var(--error);
  font-size: 13px;
}

.form-error {
  color: var(--error);
  font-size: 12.5px;
}
</style>
