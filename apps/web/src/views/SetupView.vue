<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ApiError, errorMessage } from '../api.js'
import { useAuth } from '../auth.js'
import Button from '../components/ui/Button.vue'
import Input from '../components/ui/Input.vue'
import { useToast } from '../components/ui/toast.js'
import AuthLayout from '../layouts/AuthLayout.vue'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD_LENGTH = 8

const router = useRouter()
const { completeSetup } = useAuth()
const toast = useToast()

const email = ref('')
const password = ref('')
const confirm = ref('')
const emailError = ref<string | null>(null)
const passwordError = ref<string | null>(null)
const confirmError = ref<string | null>(null)
const error = ref<string | null>(null)
const submitting = ref(false)

async function submit(): Promise<void> {
  emailError.value = EMAIL_PATTERN.test(email.value.trim()) ? null : 'Enter a valid email address.'
  passwordError.value =
    password.value.length >= MIN_PASSWORD_LENGTH
      ? null
      : `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  confirmError.value = confirm.value === password.value ? null : 'Passwords do not match.'
  if (emailError.value !== null || passwordError.value !== null || confirmError.value !== null)
    return

  submitting.value = true
  error.value = null
  try {
    await completeSetup(email.value.trim(), password.value)
    toast.success('Administrator account created')
    await router.replace('/')
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      toast.error('Setup is already complete', 'Sign in with the existing account.')
      await router.replace({ name: 'login' })
      return
    }
    error.value = errorMessage(err, 'Could not create the account. Try again.')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthLayout
    title="Create the administrator account"
    subtitle="This instance has no users yet. The first account owns the deployment."
  >
    <form class="form" novalidate @submit.prevent="submit">
      <Input
        v-model="email"
        label="Email"
        type="email"
        autocomplete="username"
        placeholder="admin@example.com"
        :error="emailError"
        required
      />
      <Input
        v-model="password"
        label="Password"
        type="password"
        autocomplete="new-password"
        :hint="`At least ${MIN_PASSWORD_LENGTH} characters.`"
        :error="passwordError"
        required
      />
      <Input
        v-model="confirm"
        label="Confirm password"
        type="password"
        autocomplete="new-password"
        :error="confirmError"
        required
      />

      <p v-if="error !== null" class="error" role="alert">{{ error }}</p>

      <Button variant="primary" type="submit" block :loading="submitting">
        Create account and sign in
      </Button>
    </form>

    <template #footer>
      <span>Two-factor authentication can be enabled once you are signed in.</span>
    </template>
  </AuthLayout>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.error {
  padding: var(--space-2) var(--space-3);
  background-color: var(--error-soft);
  border: 1px solid color-mix(in srgb, var(--error) 40%, transparent);
  border-radius: var(--radius-sm);
  color: var(--thread-ink);
  font-size: 13px;
}
</style>
