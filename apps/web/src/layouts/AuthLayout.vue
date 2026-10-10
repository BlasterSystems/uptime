<script setup lang="ts">
/** Centered card shell for the two signed-out screens (login, first-run setup). */
withDefaults(defineProps<{ title: string; subtitle?: string }>(), {})
</script>

<template>
  <div class="auth">
    <div class="auth-panel">
      <header class="auth-brand">
        <span class="brand-mark" aria-hidden="true">U</span>
        <span class="brand-name">Uptime Monitoring</span>
      </header>

      <section class="auth-card">
        <div class="auth-heading">
          <h1 class="auth-title">{{ title }}</h1>
          <p v-if="subtitle !== undefined" class="auth-subtitle">{{ subtitle }}</p>
        </div>
        <slot />
      </section>

      <p v-if="$slots.footer" class="auth-footer">
        <slot name="footer" />
      </p>
    </div>
  </div>
</template>

<style scoped>
.auth {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: var(--space-5) var(--space-4);
  background: radial-gradient(circle at 20% 0%, var(--accent-soft), transparent 55%), var(--bg);
}

.auth-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  width: 100%;
  max-width: 400px;
}

.auth-brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
}

.brand-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  background-color: var(--accent);
  border-radius: 9px;
  color: var(--accent-fg);
  font-size: 14px;
  font-weight: 700;
}

.brand-name {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.auth-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.auth-heading {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.auth-title {
  font-size: 18px;
  font-weight: 650;
}

.auth-subtitle {
  color: var(--muted);
  font-size: 13px;
}

.auth-footer {
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}
</style>
