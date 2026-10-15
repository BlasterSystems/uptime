<script setup lang="ts">
/** Centered card shell for the two signed-out screens (login, first-run setup). */
withDefaults(defineProps<{ title: string; subtitle?: string }>(), {})
</script>

<template>
  <div class="auth">
    <div class="auth-panel">
      <header class="auth-brand">
        <span class="brand-mark" aria-hidden="true">
          <span class="mark-node" />
          <span class="mark-line" />
          <span class="mark-square" />
        </span>
        <span class="brand-text">
          <span class="brand-name">Uptime Monitoring</span>
          <span class="brand-endorsement">A BlasterSystems product</span>
        </span>
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
  background-color: var(--paper);
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
  gap: 10px;
}

/* The DS thread mark: ○ transparency — vermilion thread — ■ on record. */
.brand-mark {
  position: relative;
  flex: none;
  width: 30px;
  height: 10px;
  color: var(--ink);
}

.mark-node {
  position: absolute;
  left: 0;
  top: 0;
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
}

.mark-line {
  position: absolute;
  left: 10px;
  right: 10px;
  top: 4.25px;
  height: 1.5px;
  background: var(--thread);
}

.mark-square {
  position: absolute;
  right: 0;
  top: 0;
  width: 10px;
  height: 10px;
  background: currentColor;
}

.brand-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.brand-name {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.015em;
  line-height: 1;
}

.brand-endorsement {
  color: var(--ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.auth-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  background-color: var(--card);
  border: 1px solid var(--rule);
  border-radius: var(--radius-lg);
}

.auth-heading {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.auth-title {
  font-size: 18px;
  font-weight: 500;
}

.auth-subtitle {
  color: var(--ink-2);
  font-size: 13px;
}

.auth-footer {
  color: var(--ink-2);
  font-size: 13px;
  text-align: center;
}
</style>
