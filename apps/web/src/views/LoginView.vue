<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ApiError, errorMessage } from '../api.js'
import { useAuth } from '../auth.js'
import Button from '../components/ui/Button.vue'
import Input from '../components/ui/Input.vue'
import AuthLayout from '../layouts/AuthLayout.vue'

const route = useRoute()
const router = useRouter()
const { state, signIn } = useAuth()

const email = ref('')
const password = ref('')
const otp = ref('')
const needsOtp = ref(false)
const notice = ref<string | null>(null)
const error = ref<string | null>(null)
const emailError = ref<string | null>(null)
const passwordError = ref<string | null>(null)
const submitting = ref(false)

const redirectTarget = computed(() => {
  const target = route.query.redirect
  if (typeof target === 'string' && target.startsWith('/') && !target.startsWith('//'))
    return target
  return '/'
})

async function submit(): Promise<void> {
  emailError.value = email.value.trim() === '' ? 'Enter your email address.' : null
  passwordError.value = password.value === '' ? 'Enter your password.' : null
  if (emailError.value !== null || passwordError.value !== null) return

  submitting.value = true
  error.value = null
  try {
    const code = otp.value.trim()
    await signIn(
      email.value.trim(),
      password.value,
      needsOtp.value && code !== '' ? code : undefined,
    )
    await router.replace(redirectTarget.value)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && err.code === '2fa_required') {
      needsOtp.value = true
      notice.value = 'Enter the code from your authenticator app to finish signing in.'
      return
    }
    error.value = errorMessage(err, 'Sign-in failed. Try again.')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthLayout title="Sign in" subtitle="Monitor uptime, incidents and notification channels.">
    <form class="form" novalidate @submit.prevent="submit">
      <Input
        v-model="email"
        label="Email"
        type="email"
        autocomplete="username"
        placeholder="you@example.com"
        :error="emailError"
        required
      />
      <Input
        v-model="password"
        label="Password"
        type="password"
        autocomplete="current-password"
        :error="passwordError"
        required
      />
      <Input
        v-if="needsOtp"
        v-model="otp"
        label="Two-factor code"
        inputmode="numeric"
        autocomplete="one-time-code"
        placeholder="123456"
      />

      <p v-if="notice !== null" class="notice">{{ notice }}</p>
      <p v-if="error !== null" class="error" role="alert">{{ error }}</p>

      <Button variant="primary" type="submit" block :loading="submitting">Sign in</Button>
    </form>

    <template #footer>
      <span v-if="state.setupRequired">
        No account yet?
        <RouterLink :to="{ name: 'setup' }">Create the administrator account</RouterLink>
      </span>
      <span v-else>Contact an administrator if you have lost access.</span>
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
