<script setup lang="ts">
import { deployTag } from '../buildInfo.js'

/** Baked-at-build deployment stamp; layouts own the spacing. */
const tag = deployTag()
</script>

<template>
  <footer class="app-footer" :title="`Deployment ${tag}`">{{ tag }}</footer>
</template>

<style scoped>
.app-footer {
  overflow: hidden;
  color: var(--ink-3);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
