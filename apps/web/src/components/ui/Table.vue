<script setup lang="ts" generic="T">
import { computed, ref } from 'vue'
import Spinner from './Spinner.vue'
import type { TableColumn } from './table.js'

const props = withDefaults(
  defineProps<{
    columns: readonly TableColumn<T>[]
    rows: readonly T[]
    rowKey?: (row: T) => string | number
    loading?: boolean
    emptyText?: string
  }>(),
  { loading: false, emptyText: 'Nothing to show' },
)

type SortDir = 'asc' | 'desc'

const sort = ref<{ key: string; dir: SortDir } | null>(null)

function cellValue(row: T, column: TableColumn<T>): unknown {
  if (column.value !== undefined) return column.value(row)
  return (row as Record<string, unknown>)[column.key]
}

function displayValue(row: T, column: TableColumn<T>): string {
  const value = cellValue(row, column)
  return value === null || value === undefined ? '—' : String(value)
}

function comparableValue(row: T, column: TableColumn<T>): string | number | null {
  const value = cellValue(row, column)
  if (typeof value === 'string' || typeof value === 'number') return value
  return null
}

/** Cycles a sortable column through ascending, descending and unsorted. */
function toggleSort(column: TableColumn<T>): void {
  if (column.sortable !== true) return
  const current = sort.value
  if (current === null || current.key !== column.key) {
    sort.value = { key: column.key, dir: 'asc' }
    return
  }
  sort.value = current.dir === 'asc' ? { key: column.key, dir: 'desc' } : null
}

const sortedRows = computed(() => {
  const current = sort.value
  if (current === null) return props.rows
  const column = props.columns.find((item) => item.key === current.key)
  if (column === undefined) return props.rows

  const factor = current.dir === 'asc' ? 1 : -1
  return [...props.rows].sort((left, right) => {
    const a = comparableValue(left, column)
    const b = comparableValue(right, column)
    if (a === null && b === null) return 0
    if (a === null) return 1
    if (b === null) return -1
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * factor
    return String(a).localeCompare(String(b)) * factor
  })
})

function ariaSort(column: TableColumn<T>): 'ascending' | 'descending' | 'none' | undefined {
  if (column.sortable !== true) return undefined
  const current = sort.value
  if (current === null || current.key !== column.key) return 'none'
  return current.dir === 'asc' ? 'ascending' : 'descending'
}

function sortIndicator(column: TableColumn<T>): string {
  const current = sort.value
  if (current === null || current.key !== column.key) return ''
  return current.dir === 'asc' ? '↑' : '↓'
}
</script>

<template>
  <div class="table-wrap">
    <table class="table">
      <thead>
        <tr>
          <th
            v-for="column in columns"
            :key="column.key"
            :aria-sort="ariaSort(column)"
            :style="column.width === undefined ? undefined : { width: column.width }"
            :class="`align-${column.align ?? 'left'}`"
          >
            <button
              v-if="column.sortable === true"
              type="button"
              class="sort-button"
              :class="`align-${column.align ?? 'left'}`"
              @click="toggleSort(column)"
            >
              <span>{{ column.label }}</span>
              <span class="sort-indicator" aria-hidden="true">{{ sortIndicator(column) }}</span>
            </button>
            <template v-else>{{ column.label }}</template>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="loading && rows.length === 0">
          <td :colspan="columns.length" class="table-status">
            <Spinner size="sm" />
            <span>Loading…</span>
          </td>
        </tr>
        <tr v-else-if="rows.length === 0">
          <td :colspan="columns.length" class="table-status">
            <slot name="empty">{{ emptyText }}</slot>
          </td>
        </tr>
        <template v-else>
          <tr v-for="(row, index) in sortedRows" :key="rowKey === undefined ? index : rowKey(row)">
            <td
              v-for="column in columns"
              :key="column.key"
              :class="`align-${column.align ?? 'left'}`"
            >
              <slot :name="`cell-${column.key}`" :row="row" :value="cellValue(row, column)">
                {{ displayValue(row, column) }}
              </slot>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.table-wrap {
  min-width: 0;
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

th {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-align: left;
  text-transform: uppercase;
  white-space: nowrap;
}

td {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

tbody tr:last-child td {
  border-bottom: 0;
}

tbody tr:hover td {
  background-color: var(--surface-2);
}

.align-right {
  text-align: right;
}

.align-center {
  text-align: center;
}

.sort-button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
  cursor: pointer;
}

.sort-button:hover {
  color: var(--fg);
}

.sort-button.align-right {
  justify-content: flex-end;
}

.sort-button.align-center {
  justify-content: center;
}

.sort-indicator {
  display: inline-block;
  min-width: 8px;
  color: var(--accent);
}

.table-status {
  padding: var(--space-5);
  color: var(--muted);
  text-align: center;
}

.table-status > span + span {
  margin-left: var(--space-2);
}
</style>
