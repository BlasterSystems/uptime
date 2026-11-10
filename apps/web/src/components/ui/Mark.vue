<script setup lang="ts">
/**
 * DS v1.1 Mark: the small mono basis label with its state glyph —
 * ■ recorded · ○ estimated · ◆ decision.
 */
withDefaults(defineProps<{ kind?: 'recorded' | 'estimated' | 'decision' }>(), {
  kind: 'recorded',
})
</script>

<template>
  <span class="mark">
    <span class="glyph" :class="`glyph--${kind}`" aria-hidden="true"></span>
    <span class="mark-text"><slot /></span>
  </span>
</template>

<style scoped>
.mark {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-label-sm);
  letter-spacing: var(--tracking-mono);
  text-transform: uppercase;
}

.mark .glyph--recorded,
.mark .glyph--decision {
  width: 7px;
  height: 7px;
}

.mark .glyph--estimated {
  width: 8px;
  height: 8px;
}

.mark-text {
  min-width: 0;
}
</style>
