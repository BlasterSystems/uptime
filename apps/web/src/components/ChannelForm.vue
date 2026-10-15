<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { createChannel, errorMessage } from '../api.js'
import type { ChannelType } from '../api.js'
import Button from './ui/Button.vue'
import Input from './ui/Input.vue'
import Modal from './ui/Modal.vue'
import Select from './ui/Select.vue'
import Switch from './ui/Switch.vue'
import { useToast } from './ui/toast.js'

interface ChannelField {
  key: string
  label: string
  kind: 'text' | 'password' | 'number' | 'select' | 'switch'
  required?: boolean
  placeholder?: string
  hint?: string
  default?: string | boolean
  options?: readonly { value: string; label: string }[]
  /** Config value must be sent as a number (port, priority). */
  numeric?: boolean
}

/** Mirrors the server-side config schemas in `@uptime/notify`. */
const CHANNEL_FIELDS: Record<ChannelType, readonly ChannelField[]> = {
  telegram: [
    { key: 'botToken', label: 'Bot token', kind: 'password', required: true },
    {
      key: 'chatId',
      label: 'Chat ID',
      kind: 'text',
      required: true,
      placeholder: '-1001234567890',
    },
  ],
  discord: [
    {
      key: 'webhookUrl',
      label: 'Webhook URL',
      kind: 'text',
      required: true,
      placeholder: 'https://discord.com/api/webhooks/…',
    },
  ],
  slack: [
    {
      key: 'webhookUrl',
      label: 'Webhook URL',
      kind: 'text',
      required: true,
      placeholder: 'https://hooks.slack.com/services/…',
    },
  ],
  email: [
    {
      key: 'smtpHost',
      label: 'SMTP host',
      kind: 'text',
      required: true,
      placeholder: 'smtp.example.com',
    },
    {
      key: 'smtpPort',
      label: 'SMTP port',
      kind: 'number',
      required: true,
      numeric: true,
      default: '587',
    },
    { key: 'secure', label: 'Use implicit TLS', kind: 'switch', default: false },
    { key: 'username', label: 'Username', kind: 'text' },
    { key: 'password', label: 'Password', kind: 'password' },
    {
      key: 'from',
      label: 'From address',
      kind: 'text',
      required: true,
      placeholder: 'alerts@example.com',
    },
    {
      key: 'to',
      label: 'To address',
      kind: 'text',
      required: true,
      placeholder: 'oncall@example.com',
    },
  ],
  ntfy: [
    { key: 'topic', label: 'Topic', kind: 'text', required: true, placeholder: 'uptime-alerts' },
    { key: 'server', label: 'Server', kind: 'text', default: 'https://ntfy.sh' },
    { key: 'token', label: 'Access token', kind: 'password' },
  ],
  gotify: [
    {
      key: 'server',
      label: 'Server',
      kind: 'text',
      required: true,
      placeholder: 'https://gotify.example.com',
    },
    { key: 'token', label: 'Application token', kind: 'password', required: true },
    { key: 'priority', label: 'Priority', kind: 'number', numeric: true, default: '5' },
  ],
  webhook: [
    {
      key: 'url',
      label: 'URL',
      kind: 'text',
      required: true,
      placeholder: 'https://example.com/hooks/uptime',
    },
    {
      key: 'method',
      label: 'Method',
      kind: 'select',
      default: 'POST',
      options: [
        { value: 'POST', label: 'POST' },
        { value: 'PUT', label: 'PUT' },
      ],
    },
  ],
}

const TYPE_OPTIONS = [
  { value: 'telegram', label: 'Telegram' },
  { value: 'discord', label: 'Discord' },
  { value: 'slack', label: 'Slack' },
  { value: 'email', label: 'Email (SMTP)' },
  { value: 'ntfy', label: 'ntfy' },
  { value: 'gotify', label: 'Gotify' },
  { value: 'webhook', label: 'Webhook' },
]

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ created: []; close: [] }>()

const toast = useToast()

const type = ref<string>('telegram')
const name = ref('')
const isDefault = ref(false)
const submitting = ref(false)
const formError = ref<string | null>(null)
const nameError = ref<string | null>(null)
const fieldErrors = reactive<Record<string, string | null>>({})
const values = reactive<Record<string, string | boolean>>({})

function isChannelType(value: string): value is ChannelType {
  return TYPE_OPTIONS.some((option) => option.value === value)
}

const fields = computed(() =>
  isChannelType(type.value) ? CHANNEL_FIELDS[type.value] : CHANNEL_FIELDS.telegram,
)

function reset(): void {
  type.value = 'telegram'
  name.value = ''
  isDefault.value = false
  submitting.value = false
  formError.value = null
  nameError.value = null
  applyDefaults()
}

function applyDefaults(): void {
  for (const key of Object.keys(values)) delete values[key]
  for (const key of Object.keys(fieldErrors)) delete fieldErrors[key]
  for (const field of fields.value) {
    values[field.key] = field.default ?? (field.kind === 'switch' ? false : '')
  }
}

watch(type, () => applyDefaults())

watch(
  () => props.open,
  (open) => {
    if (open) reset()
  },
)

function buildConfig(): Record<string, unknown> | null {
  const config: Record<string, unknown> = {}
  let valid = true
  for (const field of fields.value) {
    if (field.kind === 'switch') {
      config[field.key] = values[field.key] === true
      continue
    }

    const raw = values[field.key]
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text === '') {
      if (field.required === true) {
        fieldErrors[field.key] = `${field.label} is required.`
        valid = false
      } else {
        fieldErrors[field.key] = null
      }
      continue
    }

    if (field.numeric === true) {
      const parsed = Number(text)
      if (!Number.isInteger(parsed) || parsed < 0) {
        fieldErrors[field.key] = 'Enter a whole number.'
        valid = false
        continue
      }
      config[field.key] = parsed
      continue
    }

    fieldErrors[field.key] = null
    config[field.key] = text
  }
  return valid ? config : null
}

async function submit(): Promise<void> {
  const trimmedName = name.value.trim()
  nameError.value = trimmedName === '' ? 'Enter a name for this channel.' : null
  const config = buildConfig()
  if (nameError.value !== null || config === null) return

  submitting.value = true
  formError.value = null
  try {
    await createChannel({
      type: isChannelType(type.value) ? type.value : 'telegram',
      name: trimmedName,
      config,
      isDefault: isDefault.value,
    })
    toast.success('Channel created', `${trimmedName} receives incident notifications.`)
    emit('created')
    emit('close')
  } catch (error) {
    formError.value = errorMessage(error, 'Could not create the channel.')
  } finally {
    submitting.value = false
  }
}

function textValue(key: string): string {
  const value = values[key]
  return typeof value === 'string' ? value : ''
}
</script>

<template>
  <Modal
    :open="open"
    title="Add notification channel"
    size="md"
    :close-on-backdrop="!submitting"
    @close="emit('close')"
  >
    <form class="channel-form" novalidate @submit.prevent="submit">
      <div class="form-grid">
        <Input
          v-model="name"
          label="Name"
          placeholder="On-call alerts"
          :error="nameError"
          required
        />
        <Select v-model="type" label="Type" :options="TYPE_OPTIONS" />
      </div>

      <div class="fields">
        <template v-for="field in fields" :key="field.key">
          <Switch
            v-if="field.kind === 'switch'"
            :model-value="values[field.key] === true"
            :label="field.label"
            :hint="field.hint"
            @update:model-value="(value) => (values[field.key] = value)"
          />
          <Select
            v-else-if="field.kind === 'select'"
            :model-value="textValue(field.key)"
            :label="field.label"
            :options="field.options ?? []"
            :error="fieldErrors[field.key] ?? null"
            @update:model-value="(value) => (values[field.key] = value)"
          />
          <Input
            v-else
            :model-value="textValue(field.key)"
            :label="field.label"
            :type="
              field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'
            "
            :placeholder="field.placeholder"
            :hint="field.hint"
            :required="field.required"
            autocomplete="off"
            :error="fieldErrors[field.key] ?? null"
            @update:model-value="(value) => (values[field.key] = value)"
          />
        </template>
      </div>

      <Switch
        v-model="isDefault"
        label="Default channel"
        hint="Used when a monitor has no channels assigned."
      />

      <p v-if="formError !== null" class="form-error" role="alert">{{ formError }}</p>
    </form>

    <template #footer>
      <Button variant="secondary" :disabled="submitting" @click="emit('close')">Cancel</Button>
      <Button variant="primary" :loading="submitting" @click="submit">Create channel</Button>
    </template>
  </Modal>
</template>

<style scoped>
.channel-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--space-4);
}

.fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
}

.form-error {
  color: var(--thread-ink);
  font-size: 13px;
}
</style>
