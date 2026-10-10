/**
 * Column definition for `Table.vue`. Cells render the stringified `value`
 * unless the table's `cell-<key>` slot provides custom markup.
 */
export interface TableColumn<T> {
  key: string
  label: string
  sortable?: boolean
  align?: 'left' | 'right' | 'center'
  /** CSS width applied to the header cell, e.g. `140px` or `20%`. */
  width?: string
  /** Display/sort value; defaults to `row[key]`. */
  value?: (row: T) => string | number | null | undefined
}
