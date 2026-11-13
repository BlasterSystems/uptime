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
  resend: [
    { key: 'apiKey', label: 'API key', kind: 'password', required: true, placeholder: 're_…' },
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
}

const TYPE_OPTIONS = [{ value: 'resend', label: 'Email (Resend)' }]

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ created: []; close: [] }>()

const toast = useToast()

const type = ref<string>('resend')
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
  isChannelType(type.value) ? CHANNEL_FIELDS[type.value] : CHANNEL_FIELDS.resend,
)

function reset(): void {
  type.value = 'resend'
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
      type: isChannelType(type.value) ? type.value : 'resend',
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
  border-top: 1px solid var(--border-1);
}

.form-error {
  color: var(--thread-ink);
  font-size: 13px;
}
</style>
