<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string
    description?: string
  }>(),
  {},
)
</script>

<template>
  <div class="empty">
    <div v-if="$slots.icon" class="empty-icon" aria-hidden="true">
      <slot name="icon" />
    </div>
    <p class="empty-title">{{ title }}</p>
    <p v-if="description !== undefined" class="empty-description">{{ description }}</p>
    <slot />
    <div v-if="$slots.actions" class="empty-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-4);
  text-align: center;
}

.empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  margin-bottom: var(--space-1);
  background-color: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 50%;
  color: var(--muted);
}

.empty-icon :deep(svg) {
  width: 18px;
  height: 18px;
}

.empty-title {
  font-size: 14px;
  font-weight: 600;
}

.empty-description {
  max-width: 46ch;
  color: var(--muted);
  font-size: 13px;
}

.empty-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
