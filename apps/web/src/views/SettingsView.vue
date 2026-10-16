<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  API_KEY_SCOPES,
  ApiError,
  changePassword,
  createApiKey,
  createUser,
  deleteApiKey,
  deleteDockerHost,
  deleteUser,
  deleteMaintenanceWindow,
  deleteStatusPage,
  disableTotp,
  errorMessage,
  fetchApiKeys,
  fetchDockerHosts,
  fetchMaintenanceWindows,
  fetchMonitors,
  fetchSettings,
  fetchStatusPages,
  fetchTags,
  fetchUsers,
  startTotpSetup,
  updateSettings,
  updateUser,
  verifyTotpSetup,
} from '../api.js'
import type {
  ApiKey,
  ApiKeyScope,
  DockerHost,
  MaintenanceScope,
  MaintenanceStrategy,
  MaintenanceWindow,
  ManagedUser,
  Monitor,
  StatusPage,
  Tag,
  UserRole,
} from '../api.js'
import { useAuth } from '../auth.js'
import { copyText } from '../clipboard.js'
import { formatDateTime } from '../format.js'
import DockerHostForm from '../components/DockerHostForm.vue'
import MaintenanceWindowForm from '../components/MaintenanceWindowForm.vue'
import StatusPageForm from '../components/StatusPageForm.vue'
import StatusIncidentsPanel from '../components/StatusIncidentsPanel.vue'
import StatusSubscriptionsPanel from '../components/StatusSubscriptionsPanel.vue'
import Badge from '../components/ui/Badge.vue'
import Button from '../components/ui/Button.vue'
import Card from '../components/ui/Card.vue'
import ConfirmDialog from '../components/ui/ConfirmDialog.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import Icon from '../components/ui/Icon.vue'
import Input from '../components/ui/Input.vue'
import Modal from '../components/ui/Modal.vue'
import Select from '../components/ui/Select.vue'
import Spinner from '../components/ui/Spinner.vue'
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
  { id: 'status-pages', label: 'Status pages' },
  { id: 'status-incidents', label: 'Status incidents' },
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'docker-hosts', label: 'Docker hosts' },
  { id: 'general', label: 'General' },
] as const

const { state, isAdmin } = useAuth()
const toast = useToast()

const tab = ref<string>('profile')

/** Admins additionally get user management. */
const visibleTabs = computed(() =>
  isAdmin.value ? [...TABS, { id: 'users', label: 'Users' }] : [...TABS],
)

/* Password change */

const pwCurrent = ref('')
const pwNext = ref('')
const pwConfirm = ref('')
const pwBusy = ref(false)
const pwError = ref<string | null>(null)

async function submitPasswordChange(): Promise<void> {
  pwError.value = null
  if (pwCurrent.value === '') {
    pwError.value = 'Enter your current password.'
    return
  }
  if (pwNext.value.length < 8) {
    pwError.value = 'The new password must be at least 8 characters.'
    return
  }
  if (pwNext.value !== pwConfirm.value) {
    pwError.value = 'The new passwords do not match.'
    return
  }
  pwBusy.value = true
  try {
    await changePassword({ currentPassword: pwCurrent.value, nextPassword: pwNext.value })
    pwCurrent.value = ''
    pwNext.value = ''
    pwConfirm.value = ''
    toast.success('Password changed', 'Other devices have been signed out.')
  } catch (error) {
    pwError.value = errorMessage(error, 'Could not change the password.')
  } finally {
    pwBusy.value = false
  }
}

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

/* Status pages */

const statusPages = ref<StatusPage[]>([])
const statusPagesLoaded = ref(false)
const statusPagesError = ref<string | null>(null)
const monitors = ref<Monitor[]>([])
const statusPageFormOpen = ref(false)
const editingStatusPage = ref<StatusPage | null>(null)
const pendingStatusPageDelete = ref<StatusPage | null>(null)
const deletingStatusPage = ref(false)

const statusPageColumns: TableColumn<StatusPage>[] = [
  { key: 'slug', label: 'Slug' },
  { key: 'title', label: 'Title' },
  { key: 'published', label: 'Published', width: '130px' },
  { key: 'link', label: 'Link', width: '110px' },
  { key: 'actions', label: '', align: 'right', width: '150px' },
]

async function loadStatusPages(): Promise<void> {
  try {
    const [pages, monitorList] = await Promise.all([fetchStatusPages(), fetchMonitors()])
    statusPages.value = pages
    monitors.value = monitorList
    statusPagesError.value = null
  } catch (error) {
    statusPagesError.value = errorMessage(error, 'Could not load status pages.')
  } finally {
    statusPagesLoaded.value = true
  }
}

function openStatusPageForm(page: StatusPage | null): void {
  editingStatusPage.value = page
  statusPageFormOpen.value = true
}

function closeStatusPageForm(): void {
  statusPageFormOpen.value = false
  editingStatusPage.value = null
}

async function onStatusPageSaved(): Promise<void> {
  toast.success(editingStatusPage.value === null ? 'Status page created' : 'Status page updated')
  await loadStatusPages()
}

async function confirmStatusPageDelete(): Promise<void> {
  if (pendingStatusPageDelete.value === null) return
  const page = pendingStatusPageDelete.value
  deletingStatusPage.value = true
  try {
    await deleteStatusPage(page.id)
    toast.success('Status page deleted', page.slug)
    pendingStatusPageDelete.value = null
    await loadStatusPages()
  } catch (error) {
    toast.error('Could not delete the status page', errorMessage(error, 'Try again.'))
  } finally {
    deletingStatusPage.value = false
  }
}

/* Maintenance windows */

const maintenanceWindows = ref<MaintenanceWindow[]>([])
const maintenanceLoaded = ref(false)
const maintenanceError = ref<string | null>(null)
const tags = ref<Tag[]>([])
const maintenanceFormOpen = ref(false)
const editingMaintenance = ref<MaintenanceWindow | null>(null)
const pendingMaintenanceDelete = ref<MaintenanceWindow | null>(null)
const deletingMaintenance = ref(false)

const SCOPE_LABELS: Record<MaintenanceScope, string> = {
  all: 'All monitors',
  ids: 'Selected monitors',
  tags: 'Tagged monitors',
}

const STRATEGY_LABELS: Record<MaintenanceStrategy, string> = {
  single: 'Single window',
  'recurring-interval': 'Repeats on an interval',
  'recurring-weekday': 'Weekly schedule',
  cron: 'Cron schedule',
}

const maintenanceColumns: TableColumn<MaintenanceWindow>[] = [
  { key: 'name', label: 'Name' },
  { key: 'scope', label: 'Scope', width: '170px' },
  { key: 'strategy', label: 'Strategy', width: '200px' },
  { key: 'active', label: 'Active', width: '120px' },
  { key: 'actions', label: '', align: 'right', width: '150px' },
]

async function loadMaintenance(): Promise<void> {
  try {
    const [windows, monitorList, tagList] = await Promise.all([
      fetchMaintenanceWindows(),
      fetchMonitors(),
      fetchTags(),
    ])
    maintenanceWindows.value = windows
    monitors.value = monitorList
    tags.value = tagList
    maintenanceError.value = null
  } catch (error) {
    maintenanceError.value = errorMessage(error, 'Could not load maintenance windows.')
  } finally {
    maintenanceLoaded.value = true
  }
}

function openMaintenanceForm(item: MaintenanceWindow | null): void {
  editingMaintenance.value = item
  maintenanceFormOpen.value = true
}

function closeMaintenanceForm(): void {
  maintenanceFormOpen.value = false
  editingMaintenance.value = null
}

async function onMaintenanceSaved(): Promise<void> {
  toast.success(
    editingMaintenance.value === null ? 'Maintenance window created' : 'Maintenance window updated',
  )
  await loadMaintenance()
}

async function confirmMaintenanceDelete(): Promise<void> {
  if (pendingMaintenanceDelete.value === null) return
  const item = pendingMaintenanceDelete.value
  deletingMaintenance.value = true
  try {
    await deleteMaintenanceWindow(item.id)
    toast.success('Maintenance window deleted', item.name)
    pendingMaintenanceDelete.value = null
    await loadMaintenance()
  } catch (error) {
    toast.error('Could not delete the maintenance window', errorMessage(error, 'Try again.'))
  } finally {
    deletingMaintenance.value = false
  }
}

/* Docker hosts */

const dockerHosts = ref<DockerHost[]>([])
const dockerHostsLoaded = ref(false)
const dockerHostsError = ref<string | null>(null)
const dockerHostFormOpen = ref(false)
const editingDockerHost = ref<DockerHost | null>(null)
const pendingDockerHostDelete = ref<DockerHost | null>(null)
const deletingDockerHost = ref(false)

const dockerHostColumns: TableColumn<DockerHost>[] = [
  { key: 'name', label: 'Name' },
  { key: 'uri', label: 'URI' },
  { key: 'hasTls', label: 'TLS', width: '110px' },
  { key: 'createdAt', label: 'Created', sortable: true, width: '170px' },
  { key: 'actions', label: '', align: 'right', width: '150px' },
]

async function loadDockerHosts(): Promise<void> {
  try {
    dockerHosts.value = await fetchDockerHosts()
    dockerHostsError.value = null
  } catch (error) {
    dockerHostsError.value = errorMessage(error, 'Could not load Docker hosts.')
  } finally {
    dockerHostsLoaded.value = true
  }
}

function openDockerHostForm(host: DockerHost | null): void {
  editingDockerHost.value = host
  dockerHostFormOpen.value = true
}

function closeDockerHostForm(): void {
  dockerHostFormOpen.value = false
  editingDockerHost.value = null
}

async function onDockerHostSaved(): Promise<void> {
  toast.success(editingDockerHost.value === null ? 'Docker host added' : 'Docker host updated')
  await loadDockerHosts()
}

async function confirmDockerHostDelete(): Promise<void> {
  if (pendingDockerHostDelete.value === null) return
  const host = pendingDockerHostDelete.value
  deletingDockerHost.value = true
  try {
    await deleteDockerHost(host.id)
    toast.success('Docker host deleted', host.name)
    pendingDockerHostDelete.value = null
    await loadDockerHosts()
  } catch (error) {
    toast.error('Could not delete the Docker host', errorMessage(error, 'Try again.'))
  } finally {
    deletingDockerHost.value = false
  }
}

/* Users (admin) */

const users = ref<ManagedUser[]>([])
const usersLoaded = ref(false)
const usersError = ref<string | null>(null)
const userFormOpen = ref(false)
const editingUser = ref<ManagedUser | null>(null)
const userBusy = ref(false)
const userEmail = ref('')
const userPassword = ref('')
const userRole = ref<UserRole>('viewer')
const userFormErrors = reactive<{ email: string | null; password: string | null }>({
  email: null,
  password: null,
})
const pendingUserDelete = ref<ManagedUser | null>(null)
const deletingUser = ref(false)

const ROLE_OPTIONS = [
  { value: 'viewer', label: 'Viewer — read-only' },
  { value: 'editor', label: 'Editor — manages monitors' },
  { value: 'admin', label: 'Admin — full access' },
]

const userColumns: TableColumn<ManagedUser>[] = [
  { key: 'email', label: 'Email' },
  { key: 'role', label: 'Role', width: '130px' },
  { key: 'totpEnabled', label: '2FA', width: '90px' },
  { key: 'createdAt', label: 'Created', sortable: true, width: '170px' },
  { key: 'actions', label: '', align: 'right', width: '150px' },
]

async function loadUsers(): Promise<void> {
  try {
    users.value = await fetchUsers()
    usersError.value = null
  } catch (error) {
    usersError.value = errorMessage(error, 'Could not load users.')
  } finally {
    usersLoaded.value = true
  }
}

function openUserForm(user: ManagedUser | null): void {
  editingUser.value = user
  userEmail.value = user?.email ?? ''
  userPassword.value = ''
  userRole.value = user?.role ?? 'viewer'
  userFormErrors.email = null
  userFormErrors.password = null
  userFormOpen.value = true
}

function closeUserForm(): void {
  userFormOpen.value = false
  editingUser.value = null
}

async function submitUserForm(): Promise<void> {
  userFormErrors.email = null
  userFormErrors.password = null
  if (editingUser.value === null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail.value.trim())) {
    userFormErrors.email = 'Enter a valid email address.'
  }
  if (userPassword.value.length < 8) {
    userFormErrors.password =
      editingUser.value === null
        ? 'The initial password must be at least 8 characters.'
        : 'Leave the password blank to keep it, or enter at least 8 characters.'
  }
  if (userFormErrors.email !== null || userFormErrors.password !== null) return

  userBusy.value = true
  try {
    if (editingUser.value === null) {
      const user = await createUser({
        email: userEmail.value.trim(),
        password: userPassword.value,
        role: userRole.value,
      })
      toast.success('User created', user.email)
    } else {
      const user = await updateUser(editingUser.value.id, {
        role: userRole.value,
        ...(userPassword.value === '' ? {} : { password: userPassword.value }),
      })
      toast.success('User updated', user.email)
    }
    closeUserForm()
    await loadUsers()
  } catch (error) {
    const fallback =
      editingUser.value === null ? 'Could not create the user.' : 'Could not update the user.'
    if (error instanceof ApiError && error.status === 409) {
      userFormErrors.email = 'That email is already in use.'
    } else {
      userFormErrors.password = errorMessage(error, fallback)
    }
  } finally {
    userBusy.value = false
  }
}

async function confirmUserDelete(): Promise<void> {
  if (pendingUserDelete.value === null) return
  const user = pendingUserDelete.value
  deletingUser.value = true
  try {
    await deleteUser(user.id)
    toast.success('User deleted', user.email)
    pendingUserDelete.value = null
    await loadUsers()
  } catch (error) {
    toast.error('Could not delete the user', errorMessage(error, 'Try again.'))
  } finally {
    deletingUser.value = false
  }
}

/* General settings */

const settingsTitle = ref('')
const settingsTimezone = ref('')
const settingsLoaded = ref(false)
const settingsError = ref<string | null>(null)
const settingsTitleError = ref<string | null>(null)
const settingsSaveError = ref<string | null>(null)
const settingsSaving = ref(false)

async function loadSettings(): Promise<void> {
  try {
    const settings = await fetchSettings()
    settingsTitle.value = settings.title
    settingsTimezone.value = settings.timezone
    settingsError.value = null
  } catch (error) {
    settingsError.value = errorMessage(error, 'Could not load settings.')
  } finally {
    settingsLoaded.value = true
  }
}

async function saveSettings(): Promise<void> {
  const trimmedTitle = settingsTitle.value.trim()
  settingsTitleError.value = trimmedTitle === '' ? 'Enter a title.' : null
  if (settingsTitleError.value !== null) return

  settingsSaving.value = true
  settingsSaveError.value = null
  try {
    const updated = await updateSettings({
      title: trimmedTitle,
      timezone: settingsTimezone.value.trim(),
    })
    if (updated !== null) {
      settingsTitle.value = updated.title
      settingsTimezone.value = updated.timezone
    }
    toast.success('Settings saved')
  } catch (error) {
    settingsSaveError.value = errorMessage(error, 'Could not save the settings.')
  } finally {
    settingsSaving.value = false
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
  if (value === 'status-pages' && isAdmin.value && !statusPagesLoaded.value) void loadStatusPages()
  if (value === 'maintenance' && isAdmin.value && !maintenanceLoaded.value) void loadMaintenance()
  if (value === 'docker-hosts' && isAdmin.value && !dockerHostsLoaded.value) void loadDockerHosts()
  if (value === 'users' && isAdmin.value && !usersLoaded.value) void loadUsers()
  if (value === 'general' && isAdmin.value && !settingsLoaded.value) void loadSettings()
})

onMounted(() => {
  if (isAdmin.value) void loadApiKeys()
})
</script>

<template>
  <div class="view">
    <Tabs v-model="tab" :tabs="visibleTabs">
      <template #tab-profile>
        <div class="stack">
          <Card title="Account" subtitle="Your sign-in identity and role.">
            <div class="form-grid">
              <Input :model-value="state.user?.email ?? ''" label="Email" readonly />
              <Input :model-value="state.user?.role ?? ''" label="Role" readonly />
            </div>
          </Card>

          <Card title="Password" subtitle="Changing the password signs out your other devices.">
            <div class="stack-sm">
              <Input
                v-model="pwCurrent"
                label="Current password"
                type="password"
                autocomplete="current-password"
              />
              <Input
                v-model="pwNext"
                label="New password"
                type="password"
                autocomplete="new-password"
                hint="At least 8 characters."
              />
              <Input
                v-model="pwConfirm"
                label="Confirm new password"
                type="password"
                autocomplete="new-password"
              />
              <p v-if="pwError !== null" class="form-error" role="alert">{{ pwError }}</p>
            </div>
            <template #footer>
              <Button variant="primary" :loading="pwBusy" @click="submitPasswordChange">
                Change password
              </Button>
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

      <template #tab-status-pages>
        <EmptyState
          v-if="!isAdmin"
          title="Administrator role required"
          description="Only administrators can manage status pages."
        >
          <template #icon><Icon name="settings" :size="18" /></template>
        </EmptyState>

        <Card
          v-else
          title="Status pages"
          subtitle="Public pages that publish monitor status."
          padding="none"
        >
          <template #actions>
            <Button variant="primary" size="sm" @click="openStatusPageForm(null)">
              <Icon name="plus" :size="14" />
              Create page
            </Button>
          </template>

          <p v-if="statusPagesError !== null" class="banner" role="alert">{{ statusPagesError }}</p>

          <Table
            :columns="statusPageColumns"
            :rows="statusPages"
            :loading="!statusPagesLoaded"
            :row-key="(row) => row.id"
          >
            <template #empty>
              <EmptyState
                title="No status pages"
                description="Create a page to publish monitor status to your users."
              />
            </template>

            <template #cell-slug="{ row }">
              <code class="mono cell-strong">{{ row.slug }}</code>
            </template>

            <template #cell-published="{ row }">
              <Badge :variant="row.published ? 'success' : 'neutral'" dot>
                {{ row.published ? 'Published' : 'Draft' }}
              </Badge>
            </template>

            <template #cell-link="{ row }">
              <a v-if="row.published" :href="'/status/' + row.slug" target="_blank" rel="noopener">
                Open
              </a>
              <span v-else class="muted">Draft</span>
            </template>

            <template #cell-actions="{ row }">
              <div class="row-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  :aria-label="`Edit status page ${row.slug}`"
                  @click="openStatusPageForm(row)"
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  :aria-label="`Delete status page ${row.slug}`"
                  @click="pendingStatusPageDelete = row"
                >
                  Delete
                </Button>
              </div>
            </template>
          </Table>
        </Card>
      </template>

      <template #tab-status-incidents>
        <EmptyState
          v-if="!isAdmin"
          title="Administrator role required"
          description="Only administrators can manage status incidents."
        >
          <template #icon><Icon name="settings" :size="18" /></template>
        </EmptyState>

        <StatusIncidentsPanel v-else />
      </template>

      <template #tab-subscriptions>
        <EmptyState
          v-if="!isAdmin"
          title="Administrator role required"
          description="Only administrators can manage status page subscriptions."
        >
          <template #icon><Icon name="settings" :size="18" /></template>
        </EmptyState>

        <StatusSubscriptionsPanel v-else />
      </template>

      <template #tab-maintenance>
        <EmptyState
          v-if="!isAdmin"
          title="Administrator role required"
          description="Only administrators can manage maintenance windows."
        >
          <template #icon><Icon name="settings" :size="18" /></template>
        </EmptyState>

        <Card
          v-else
          title="Maintenance windows"
          subtitle="Suppress alerts while you deploy or migrate."
          padding="none"
        >
          <template #actions>
            <Button variant="primary" size="sm" @click="openMaintenanceForm(null)">
              <Icon name="plus" :size="14" />
              Create window
            </Button>
          </template>

          <p v-if="maintenanceError !== null" class="banner" role="alert">{{ maintenanceError }}</p>

          <Table
            :columns="maintenanceColumns"
            :rows="maintenanceWindows"
            :loading="!maintenanceLoaded"
            :row-key="(row) => row.id"
          >
            <template #empty>
              <EmptyState
                title="No maintenance windows"
                description="Create a window to silence alerts during planned work."
              />
            </template>

            <template #cell-name="{ row }">
              <span class="cell-strong">{{ row.name }}</span>
            </template>

            <template #cell-scope="{ row }">
              <span class="text-note">{{ SCOPE_LABELS[row.scope] }}</span>
            </template>

            <template #cell-strategy="{ row }">
              <span class="text-note">{{ STRATEGY_LABELS[row.strategy] }}</span>
            </template>

            <template #cell-active="{ row }">
              <Badge :variant="row.active ? 'success' : 'neutral'" dot>
                {{ row.active ? 'Active' : 'Inactive' }}
              </Badge>
            </template>

            <template #cell-actions="{ row }">
              <div class="row-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  :aria-label="`Edit maintenance window ${row.name}`"
                  @click="openMaintenanceForm(row)"
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  :aria-label="`Delete maintenance window ${row.name}`"
                  @click="pendingMaintenanceDelete = row"
                >
                  Delete
                </Button>
              </div>
            </template>
          </Table>
        </Card>
      </template>

      <template #tab-docker-hosts>
        <EmptyState
          v-if="!isAdmin"
          title="Administrator role required"
          description="Only administrators can manage Docker hosts."
        >
          <template #icon><Icon name="settings" :size="18" /></template>
        </EmptyState>

        <Card
          v-else
          title="Docker hosts"
          subtitle="Reusable Docker endpoints with optional TLS material."
          padding="none"
        >
          <template #actions>
            <Button variant="primary" size="sm" @click="openDockerHostForm(null)">
              <Icon name="plus" :size="14" />
              Add host
            </Button>
          </template>

          <p v-if="dockerHostsError !== null" class="banner" role="alert">
            {{ dockerHostsError }}
          </p>

          <Table
            :columns="dockerHostColumns"
            :rows="dockerHosts"
            :loading="!dockerHostsLoaded"
            :row-key="(row) => row.id"
          >
            <template #empty>
              <EmptyState
                title="No Docker hosts"
                description="Add a host so container monitors can inspect it over the Docker API."
              />
            </template>

            <template #cell-name="{ row }">
              <span class="cell-strong">{{ row.name }}</span>
            </template>

            <template #cell-uri="{ row }">
              <code class="mono">{{ row.uri }}</code>
            </template>

            <template #cell-hasTls="{ row }">
              <Badge :variant="row.hasTls ? 'success' : 'neutral'" dot>
                {{ row.hasTls ? 'TLS' : 'Plain' }}
              </Badge>
            </template>

            <template #cell-createdAt="{ row }">
              <span class="tabular">{{ formatDateTime(row.createdAt) }}</span>
            </template>

            <template #cell-actions="{ row }">
              <div class="row-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  :aria-label="`Edit Docker host ${row.name}`"
                  @click="openDockerHostForm(row)"
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  :aria-label="`Delete Docker host ${row.name}`"
                  @click="pendingDockerHostDelete = row"
                >
                  Delete
                </Button>
              </div>
            </template>
          </Table>
        </Card>
      </template>

      <template #tab-users>
        <EmptyState
          v-if="!isAdmin"
          title="Administrator role required"
          description="Only administrators can manage user access."
        />
        <div v-else class="stack">
          <p v-if="usersError !== null" class="banner" role="alert">{{ usersError }}</p>

          <Card title="Users" subtitle="Accounts with dashboard access. Password resets sign the user out everywhere.">
            <template #actions>
              <Button variant="primary" size="sm" @click="openUserForm(null)">
                <Icon name="plus" :size="14" />
                Add user
              </Button>
            </template>
            <Table
              :columns="userColumns"
              :rows="users"
              :loading="!usersLoaded"
              :row-key="(row) => row.id"
            >
              <template #empty>
                <span>No users yet. Create one to grant dashboard access.</span>
              </template>
              <template #cell-role="{ row }">
                <Badge variant="accent" mono>{{ row.role }}</Badge>
              </template>
              <template #cell-totpEnabled="{ row }">
                <Badge :variant="row.totpEnabled ? 'success' : 'neutral'">
                  {{ row.totpEnabled ? '2FA on' : '2FA off' }}
                </Badge>
              </template>
              <template #cell-createdAt="{ row }">
                <span class="tabular">{{ formatDateTime(row.createdAt) }}</span>
              </template>
              <template #cell-actions="{ row }">
                <div class="row-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    :aria-label="`Edit user ${row.email}`"
                    @click="openUserForm(row)"
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    :disabled="row.id === state.user?.id"
                    :aria-label="`Delete user ${row.email}`"
                    @click="pendingUserDelete = row"
                  >
                    Delete
                  </Button>
                </div>
              </template>
            </Table>
          </Card>
        </div>
      </template>

      <template #tab-general>
        <EmptyState
          v-if="!isAdmin"
          title="Administrator role required"
          description="Only administrators can change the application settings."
        >
          <template #icon><Icon name="settings" :size="18" /></template>
        </EmptyState>

        <Card v-else title="Application" subtitle="Instance title and reporting timezone.">
          <p v-if="settingsError !== null" class="banner" role="alert">{{ settingsError }}</p>

          <div v-if="!settingsLoaded" class="loading-row">
            <Spinner size="sm" />
            <span class="text-note">Loading settings…</span>
          </div>

          <div v-else class="stack-sm">
            <div class="form-grid">
              <Input
                v-model="settingsTitle"
                label="Title"
                placeholder="Uptime"
                required
                :error="settingsTitleError"
              />
              <Input
                v-model="settingsTimezone"
                label="Timezone"
                placeholder="Europe/Lisbon"
                hint="IANA timezone, such as Europe/Lisbon"
              />
            </div>
            <p v-if="settingsSaveError !== null" class="form-error" role="alert">
              {{ settingsSaveError }}
            </p>
          </div>

          <template #footer>
            <Button
              variant="primary"
              :loading="settingsSaving"
              :disabled="!settingsLoaded"
              @click="saveSettings"
            >
              Save
            </Button>
          </template>
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

    <StatusPageForm
      :open="statusPageFormOpen"
      :page="editingStatusPage"
      :monitors="monitors"
      @saved="onStatusPageSaved"
      @close="closeStatusPageForm"
    />

    <MaintenanceWindowForm
      :open="maintenanceFormOpen"
      :window="editingMaintenance"
      :monitors="monitors"
      :tags="tags"
      @saved="onMaintenanceSaved"
      @close="closeMaintenanceForm"
    />

    <DockerHostForm
      :open="dockerHostFormOpen"
      :host="editingDockerHost"
      @saved="onDockerHostSaved"
      @close="closeDockerHostForm"
    />

    <ConfirmDialog
      :open="pendingStatusPageDelete !== null"
      title="Delete status page"
      :message="
        pendingStatusPageDelete === null
          ? undefined
          : `“${pendingStatusPageDelete.slug}” stops responding immediately. This cannot be undone.`
      "
      confirm-label="Delete page"
      danger
      :loading="deletingStatusPage"
      @confirm="confirmStatusPageDelete"
      @cancel="pendingStatusPageDelete = null"
    />

    <ConfirmDialog
      :open="pendingMaintenanceDelete !== null"
      title="Delete maintenance window"
      :message="
        pendingMaintenanceDelete === null
          ? undefined
          : `“${pendingMaintenanceDelete.name}” stops silencing alerts. This cannot be undone.`
      "
      confirm-label="Delete window"
      danger
      :loading="deletingMaintenance"
      @confirm="confirmMaintenanceDelete"
      @cancel="pendingMaintenanceDelete = null"
    />

    <ConfirmDialog
      :open="pendingDockerHostDelete !== null"
      title="Delete Docker host"
      :message="
        pendingDockerHostDelete === null
          ? undefined
          : `Monitors using “${pendingDockerHostDelete.name}” keep their inline host URI; the stored host and its TLS material are removed.`
      "
      confirm-label="Delete host"
      danger
      :loading="deletingDockerHost"
      @confirm="confirmDockerHostDelete"
      @cancel="pendingDockerHostDelete = null"
    />

    <Modal
      :open="userFormOpen"
      :title="editingUser === null ? 'Add user' : `Edit ${editingUser.email}`"
      size="sm"
      @close="closeUserForm"
    >
      <div class="stack-sm">
        <Input
          v-model="userEmail"
          label="Email"
          type="email"
          autocomplete="off"
          :disabled="editingUser !== null"
          :error="userFormErrors.email"
        />
        <Select
          v-model="userRole"
          label="Role"
          :options="ROLE_OPTIONS"
          hint="Admin manages users and settings; editor manages monitors; viewer is read-only."
        />
        <Input
          v-model="userPassword"
          label="Password"
          type="password"
          autocomplete="new-password"
          :placeholder="editingUser === null ? '' : 'Leave blank to keep the current password'"
          :error="userFormErrors.password"
        />
      </div>
      <template #footer>
        <Button variant="secondary" :disabled="userBusy" @click="closeUserForm">Cancel</Button>
        <Button variant="primary" :loading="userBusy" @click="submitUserForm">
          {{ editingUser === null ? 'Create user' : 'Save changes' }}
        </Button>
      </template>
    </Modal>

    <ConfirmDialog
      :open="pendingUserDelete !== null"
      :title="`Delete ${pendingUserDelete?.email ?? 'user'}?`"
      :message="`Remove ${pendingUserDelete?.email ?? ''} from this instance? Their sessions are signed out immediately.`"
      confirm-label="Delete user"
      danger
      :loading="deletingUser"
      @confirm="confirmUserDelete"
      @cancel="pendingUserDelete = null"
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

.row-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-1);
}

.loading-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.cell-strong {
  font-weight: 500;
}

.tabular {
  font-variant-numeric: tabular-nums;
}

.banner {
  padding: var(--space-3) var(--space-4);
  background-color: var(--error-soft);
  color: var(--thread-ink);
  font-size: 13px;
}

.form-error {
  color: var(--thread-ink);
  font-size: 12.5px;
}
</style>
