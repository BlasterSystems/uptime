<script setup lang="ts">
/**
 * DS v1.1 alert row: a decision glyph plus the message on a hairline —
 * never a boxed banner. Title says what happened; the body says why.
 */
</script>

<template>
  <p class="alert-row" role="alert">
    <span class="alert-glyph" aria-hidden="true"></span>
    <span class="alert-text"><slot /></span>
  </p>
</template>

<style scoped>
.alert-row {
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr);
  gap: 12px;
  margin: 0;
  padding: 10px 0;
  border-top: 1px solid var(--border-1);
  color: var(--ink);
  font-size: var(--fs-ui);
  line-height: 1.45;
}

.alert-glyph {
  width: 8px;
  height: 8px;
  margin-top: 6px;
  margin-left: 1px;
  border: 1.5px solid var(--thread);
  transform: rotate(45deg);
}

.alert-text {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
