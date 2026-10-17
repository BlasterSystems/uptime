<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ApiError, errorMessage, resetPassword } from '../api.js'
import Button from '../components/ui/Button.vue'
import Input from '../components/ui/Input.vue'
import AuthLayout from '../layouts/AuthLayout.vue'

const route = useRoute()
const router = useRouter()

const token = computed(() => (typeof route.query.token === 'string' ? route.query.token : ''))
const password = ref('')
const confirm = ref('')
const passwordError = ref<string | null>(null)
const confirmError = ref<string | null>(null)
const error = ref<string | null>(null)
const submitting = ref(false)

async function submit(): Promise<void> {
  passwordError.value =
    password.value.length < 8 ? 'Password must be at least 8 characters.' : null
  confirmError.value = confirm.value !== password.value ? 'Passwords do not match.' : null
  if (passwordError.value !== null || confirmError.value !== null) return

  submitting.value = true
  error.value = null
  try {
    await resetPassword(token.value, password.value)
    await router.replace({ name: 'login', query: { reset: '1' } })
  } catch (err) {
    if (err instanceof ApiError && err.status === 400 && err.code === 'invalid_token') {
      error.value = 'This reset link is no longer valid. Request a new one from the sign-in page.'
      return
    }
    error.value = errorMessage(err, 'Could not reset the password. Try again.')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthLayout title="Choose a new password" subtitle="Your other sessions are signed out once the password changes.">
    <form v-if="token !== ''" class="form" novalidate @submit.prevent="submit">
      <Input
        v-model="password"
        label="New password"
        type="password"
        autocomplete="new-password"
        hint="At least 8 characters."
        :error="passwordError"
        required
      />
      <Input
        v-model="confirm"
        label="Confirm new password"
        type="password"
        autocomplete="new-password"
        :error="confirmError"
        required
      />
      <p v-if="error !== null" class="error" role="alert">{{ error }}</p>
      <Button variant="primary" type="submit" block :loading="submitting">Update password</Button>
    </form>
    <p v-else class="error" role="alert">
      This reset link is malformed. Request a new one from the sign-in page.
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

.error {
  padding: var(--space-2) var(--space-3);
  background-color: var(--error-soft);
  border: 1px solid color-mix(in srgb, var(--error) 40%, transparent);
  border-radius: var(--radius-sm);
  color: var(--thread-ink);
  font-size: 13px;
}
</style>
