<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import { errorMessage, requestPasswordReset } from '../api.js'
import Button from '../components/ui/Button.vue'
import Input from '../components/ui/Input.vue'
import AuthLayout from '../layouts/AuthLayout.vue'

const email = ref('')
const emailError = ref<string | null>(null)
const error = ref<string | null>(null)
const submitting = ref(false)
const sent = ref(false)

async function submit(): Promise<void> {
  emailError.value = email.value.trim() === '' ? 'Enter your email address.' : null
  if (emailError.value !== null) return

  submitting.value = true
  error.value = null
  try {
    await requestPasswordReset(email.value.trim())
    sent.value = true
  } catch (err) {
    error.value = errorMessage(err, 'Could not send the reset email. Try again.')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthLayout
    title="Reset your password"
    subtitle="We email a single-use reset link valid for one hour."
  >
    <form v-if="!sent" class="form" novalidate @submit.prevent="submit">
      <Input
        v-model="email"
        label="Email"
        type="email"
        autocomplete="username"
        placeholder="you@example.com"
        :error="emailError"
        required
      />
      <p v-if="error !== null" class="error" role="alert">{{ error }}</p>
      <Button variant="primary" type="submit" block :loading="submitting">Send reset link</Button>
    </form>
    <p v-else class="notice" role="status">
      If an account exists for <strong>{{ email.trim() }}</strong
      >, a reset link is on its way. Check your inbox.
    </p>

    <template #footer>
      <RouterLink :to="{ name: 'login' }">Back to sign in</RouterLink>
    </template>
  </AuthLayout>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.notice {
  color: var(--muted);
  font-size: 13px;
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
