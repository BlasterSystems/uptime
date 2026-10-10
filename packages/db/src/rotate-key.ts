import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import Sqlite from 'better-sqlite3'

import { SecretBox } from './crypto.js'

/**
 * Encryption-key rotation (ADR-0002): re-encrypt every secret column stored at
 * rest from the old key to a new one, in place. Stop the server first, then:
 *
 *   node dist/rotate-key.js --db /data/uptime.db --from <old> --to <new>
 *
 * (`node --experimental-strip-types src/rotate-key.ts` is not supported: type
 * stripping does not map the `.js` relative imports to the `.ts` sources —
 * verified on Node 24 — so the compiled entry is the supported one. The only
 * dependency beyond better-sqlite3 is the crypto module.)
 */

/** One encrypted column handled by {@link rotateEncryptionKey}. */
interface EncryptedColumn {
  table: string
  column: string
}

/** Every column encrypted at rest (ADR-0002); keep in sync with the schema. */
const ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  { table: 'notification_channels', column: 'config_enc' },
  { table: 'users', column: 'totp_secret_enc' },
  { table: 'users', column: 'recovery_codes_enc' },
  { table: 'push_tokens', column: 'token_enc' },
  { table: 'docker_hosts', column: 'tls_ca_enc' },
  { table: 'docker_hosts', column: 'tls_cert_enc' },
  { table: 'docker_hosts', column: 'tls_key_enc' },
]

export interface RotateEncryptionKeyArgs {
  dbFile: string
  fromKey: string
  toKey: string
}

export interface RotatedColumn {
  table: string
  column: string
  /** Non-null values re-encrypted in this rotation. */
  rows: number
}

export interface RotateEncryptionKeyResult {
  /** One entry per column that held at least one ciphertext. */
  reencrypted: RotatedColumn[]
  /** Ciphertexts the old key could not open; left untouched for inspection. */
  failed: number
}

interface ColumnBatch {
  table: string
  column: string
  rows: Array<{ id: number; value: string }>
}

/**
 * Re-encrypt every {@link ENCRYPTED_COLUMNS} value from `fromKey` to `toKey`.
 * The new ciphertexts are collected first and written in one transaction, so a
 * failure never leaves the database half-rotated (readable with neither key).
 * Rows the old key cannot decrypt are skipped and reported in `failed`.
 */
export async function rotateEncryptionKey(
  args: RotateEncryptionKeyArgs,
): Promise<RotateEncryptionKeyResult> {
  if (!existsSync(args.dbFile)) {
    throw new Error(`database file not found: ${args.dbFile}`)
  }
  const from = new SecretBox(args.fromKey)
  const to = new SecretBox(args.toKey)
  const sqlite = new Sqlite(args.dbFile)
  try {
    const batches: ColumnBatch[] = []
    let failed = 0
    for (const { table, column } of ENCRYPTED_COLUMNS) {
      // Names come from the constant table above, never from input.
      const select = sqlite.prepare(
        `SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`,
      )
      const rows: ColumnBatch['rows'] = []
      for (const row of select.all() as Array<{ id: number; value: string }>) {
        try {
          rows.push({ id: row.id, value: to.encrypt(from.decrypt(row.value)) })
        } catch {
          // Written by a different key (or corrupt): leave it for its owner.
          failed += 1
        }
      }
      if (rows.length > 0) batches.push({ table, column, rows })
    }
    sqlite.transaction((pending: ColumnBatch[]) => {
      for (const { table, column, rows } of pending) {
        const update = sqlite.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`)
        for (const row of rows) update.run(row.value, row.id)
      }
    })(batches)
    return {
      reencrypted: batches.map(({ table, column, rows }) => ({
        table,
        column,
        rows: rows.length,
      })),
      failed,
    }
  } finally {
    sqlite.close()
  }
}

const USAGE = [
  'Usage: rotate-key --db <database> --from <old-key> --to <new-key>',
  '',
  'Re-encrypts every secret column (notification configs, TOTP secrets, recovery',
  'codes, push tokens, Docker TLS material) from the old key to the new one.',
  'Stop the server before rotating. Keys are 32 bytes: 64 hex chars, 44-char',
  'base64url/base64, or 32 raw bytes.',
].join('\n')

/** Parse `--db/--from/--to` pairs; `'help'` for -h/--help, `null` when malformed. */
function parseRotateArgs(argv: string[]): RotateEncryptionKeyArgs | 'help' | null {
  let db: string | undefined
  let from: string | undefined
  let to: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h') return 'help'
    // `pnpm run rotate-key -- --db …` forwards the separator; let it through.
    if (flag === '--') continue
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) return null
    if (flag === '--db') db = value
    else if (flag === '--from') from = value
    else if (flag === '--to') to = value
    else return null
    i += 1
  }
  if (db === undefined || from === undefined || to === undefined) return null
  return { dbFile: db, fromKey: from, toKey: to }
}

/**
 * CLI entry: runs {@link rotateEncryptionKey} and prints the result as JSON.
 * Returns the process exit code (0 success/help, 1 usage or rotation error) so
 * a direct invocation can set `process.exitCode` without `process.exit`, which
 * could truncate output.
 */
export async function runRotateCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseRotateArgs(argv)
  if (args === 'help') {
    console.log(USAGE)
    return 0
  }
  if (args === null) {
    console.error(USAGE)
    return 1
  }
  try {
    console.log(JSON.stringify(await rotateEncryptionKey(args)))
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

// Executed directly (`node dist/rotate-key.js …`) rather than imported by tests
// or a future caller: run the CLI and mirror its exit code.
const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  void runRotateCli().then((code) => {
    process.exitCode = code
  })
}
