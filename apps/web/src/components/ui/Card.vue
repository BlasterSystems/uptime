<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string
    subtitle?: string
    /** `none` drops the padding — for tables that draw their own row spacing. */
    padding?: 'none' | 'sm' | 'md'
  }>(),
  { padding: 'md' },
)
</script>

<template>
  <section class="card">
    <header
      v-if="title !== undefined || subtitle !== undefined || $slots.header || $slots.actions"
      class="card-head"
    >
      <div class="card-heading">
        <slot name="header">
          <h2 v-if="title !== undefined" class="card-title">{{ title }}</h2>
          <p v-if="subtitle !== undefined" class="card-subtitle">{{ subtitle }}</p>
        </slot>
      </div>
      <div v-if="$slots.actions" class="card-actions">
        <slot name="actions" />
      </div>
    </header>

    <div class="card-body" :class="`pad-${padding}`">
      <slot />
    </div>

    <footer v-if="$slots.footer" class="card-foot">
      <slot name="footer" />
    </footer>
  </section>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-4) 0;
}

.card-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.card-title {
  font-size: 15px;
  font-weight: 600;
}

.card-subtitle {
  color: var(--muted);
  font-size: 12.5px;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.card-body {
  min-width: 0;
}

.pad-none {
  padding: 0;
}

.pad-sm {
  padding: var(--space-3);
}

.pad-md {
  padding: var(--space-4);
}

.card-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: 0 var(--space-4) var(--space-4);
}
</style>
