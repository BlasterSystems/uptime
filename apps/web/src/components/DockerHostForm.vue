<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { createDockerHost, errorMessage, updateDockerHost } from '../api.js'
import type { DockerHost, DockerHostInput } from '../api.js'
import Button from './ui/Button.vue'
import Input from './ui/Input.vue'
import Modal from './ui/Modal.vue'
import Textarea from './ui/Textarea.vue'

const props = withDefaults(defineProps<{ open: boolean; host?: DockerHost | null }>(), {
  host: null,
})

const emit = defineEmits<{ saved: []; close: [] }>()

const editing = computed(() => props.host ?? null)
const isEdit = computed(() => editing.value !== null)

function defaultFormState() {
  return {
    name: '',
    uri: '',
    tlsCa: '',
    tlsCert: '',
    tlsKey: '',
  }
}

const form = reactive(defaultFormState())
const nameError = ref<string | null>(null)
const uriError = ref<string | null>(null)
const submitting = ref(false)
const formError = ref<string | null>(null)

function reset(): void {
  const current = props.host ?? null
  Object.assign(form, defaultFormState())
  if (current !== null) {
    form.name = current.name
    form.uri = current.uri
  }
  nameError.value = null
  uriError.value = null
  formError.value = null
  submitting.value = false
}

watch(
  () => props.open,
  (open) => {
    if (open) reset()
  },
)

function buildInput(): DockerHostInput | null {
  const name = form.name.trim()
  nameError.value = name === '' ? 'Enter a name.' : null

  const uri = form.uri.trim()
  if (uri === '') {
    uriError.value = 'Enter the Docker host URI.'
  } else if (!uri.startsWith('unix://') && !uri.startsWith('tcp://')) {
    uriError.value = 'Use a unix:// path or a tcp://host:port URL.'
  } else {
    uriError.value = null
  }

  if (nameError.value !== null || uriError.value !== null) return null

  // Blank TLS fields keep the stored value (edit) or mean "no TLS" (create).
  const tlsCa = form.tlsCa.trim()
  const tlsCert = form.tlsCert.trim()
  const tlsKey = form.tlsKey.trim()
  return {
    name,
    uri,
    ...(tlsCa === '' ? {} : { tlsCa }),
    ...(tlsCert === '' ? {} : { tlsCert }),
    ...(tlsKey === '' ? {} : { tlsKey }),
  }
}

async function submit(): Promise<void> {
  const input = buildInput()
  if (input === null) return

  submitting.value = true
  formError.value = null
  try {
    const current = editing.value
    if (current === null) {
      await createDockerHost(input)
    } else {
      await updateDockerHost(current.id, input)
    }
    emit('saved')
    emit('close')
  } catch (error) {
    formError.value = errorMessage(
      error,
      isEdit.value ? 'Could not save the Docker host.' : 'Could not create the Docker host.',
    )
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Modal
    :open="open"
    :title="isEdit ? 'Edit Docker host' : 'Add Docker host'"
    size="lg"
    :close-on-backdrop="!submitting"
    @close="emit('close')"
  >
    <form class="docker-host-form" novalidate @submit.prevent="submit">
      <div class="form-grid">
        <Input
          v-model="form.name"
          label="Name"
          placeholder="Production swarm"
          :error="nameError"
          required
        />
        <Input
          v-model="form.uri"
          label="URI"
          placeholder="unix:///var/run/docker.sock"
          autocomplete="off"
          mono
          hint="unix:///path/to/docker.sock or tcp://host:port."
          :error="uriError"
          required
        />
      </div>

      <div class="section">
        <p class="section-title">TLS certificates</p>
        <p class="section-note">
          Optional; required by TLS-protected tcp:// endpoints. All PEM values are stored encrypted
          at rest.<template v-if="isEdit"> Leave a field blank to keep the stored value.</template>
        </p>
        <Textarea
          v-model="form.tlsCa"
          label="CA bundle (PEM)"
          :rows="3"
          mono
          hint="Stored encrypted at rest."
        />
        <Textarea
          v-model="form.tlsCert"
          label="Client certificate (PEM)"
          :rows="3"
          mono
          hint="Stored encrypted at rest."
        />
        <Textarea
          v-model="form.tlsKey"
          label="Client key (PEM)"
          :rows="3"
          mono
          hint="Stored encrypted at rest."
        />
      </div>

      <p v-if="formError !== null" class="form-error" role="alert">{{ formError }}</p>
    </form>

    <template #footer>
      <Button variant="secondary" :disabled="submitting" @click="emit('close')">Cancel</Button>
      <Button variant="primary" :loading="submitting" @click="submit">
        {{ isEdit ? 'Save changes' : 'Add host' }}
      </Button>
    </template>
  </Modal>
</template>

<style scoped>
.docker-host-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-4);
}

.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
}

.section-title {
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.section-note {
  color: var(--muted);
  font-size: 12.5px;
}

.form-error {
  color: var(--thread-ink);
  font-size: 13px;
}
</style>
