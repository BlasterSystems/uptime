import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'
import Sqlite from 'better-sqlite3'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import { Database } from './index.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const DRIZZLE_DIR = fileURLToPath(new URL('../drizzle', import.meta.url))

/** Applies migrations 0000–0007 (pre-prune schema, legacy channel types allowed). */
function openPrePruneDb(file: string): SqliteConnection {
  const base = mkdtempSync(join(tmpdir(), 'uptime-mig-'))
  tempDirs.push(base)
  const trimmed = join(base, 'drizzle-0007')
  cpSync(DRIZZLE_DIR, trimmed, { recursive: true })
  rmSync(join(trimmed, '0008_prune_notification_channels.sql'))
  rmSync(join(trimmed, 'meta', '0008_snapshot.json'))
  const journalPath = join(trimmed, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ tag: string }>
  }
  journal.entries = journal.entries.filter(
    (entry) => entry.tag !== '0008_prune_notification_channels',
  )
  writeFileSync(journalPath, JSON.stringify(journal, null, 2))

  const raw = new Sqlite(file)
  raw.pragma('foreign_keys = ON')
  migrate(drizzle(raw), { migrationsFolder: trimmed })
  return raw
}

/** The migration file set is frozen history; the tag is asserted to catch renames. */
const MIGRATION_0008 = '0008_prune_notification_channels'

interface CountRow {
  n: number
}

describe(`migration ${MIGRATION_0008} (notify prune, ADR-0007)`, () => {
  it('deletes non-resend channels with their routing and subscription orphans', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptime-prune-'))
    tempDirs.push(dir)
    const dbFile = join(dir, 'uptime.db')
    const now = Date.now()

    const pre = openPrePruneDb(dbFile)
    pre.exec(`
      INSERT INTO notification_channels (type, name, config_enc, created_at, updated_at) VALUES
        ('resend', 'keep', 'enc:keep', ${now}, ${now}),
        ('slack', 'legacy-chat', 'enc:chat', ${now}, ${now}),
        ('webhook', 'legacy-hook', 'enc:hook', ${now}, ${now});
      INSERT INTO monitors (type, name, config_json, created_at, updated_at)
        VALUES ('http', 'api', '{"url":"https://example.com"}', ${now}, ${now});
      INSERT INTO status_pages (slug, title, published, created_at, updated_at)
        VALUES ('ops', 'Ops', 1, ${now}, ${now});
    `)
    const keepId = pre
      .prepare<[], { id: number }>("SELECT id FROM notification_channels WHERE name = 'keep'")
      .get()!.id
    const chatId = pre
      .prepare<[], { id: number }>(
        "SELECT id FROM notification_channels WHERE name = 'legacy-chat'",
      )
      .get()!.id
    const hookId = pre
      .prepare<[], { id: number }>(
        "SELECT id FROM notification_channels WHERE name = 'legacy-hook'",
      )
      .get()!.id
    const httpId = pre.prepare<[], { id: number }>('SELECT id FROM monitors').get()!.id
    const pageId = pre.prepare<[], { id: number }>('SELECT id FROM status_pages').get()!.id
    pre.exec(`
      INSERT INTO monitor_notifications (monitor_id, channel_id) VALUES
        (${httpId}, ${keepId}), (${httpId}, ${chatId});
      INSERT INTO status_subscriptions (page_id, channel_id, component_ids, events, created_at) VALUES
        (${pageId}, ${keepId}, '[]', '[]', ${now}),
        (${pageId}, ${hookId}, '["api"]', '["incident_open"]', ${now});
    `)
    // Rows dangling at nonexistent channel ids are possible only under historical
    // `PRAGMA foreign_keys = OFF` runs — exactly what the `NOT IN` sweeps exist for.
    pre.pragma('foreign_keys = OFF')
    pre.exec(`
      INSERT INTO monitor_notifications (monitor_id, channel_id) VALUES (${httpId}, 99999);
      INSERT INTO status_subscriptions (page_id, channel_id, component_ids, events, created_at) VALUES
        (${pageId}, 88888, '[]', '[]', ${now});
    `)
    pre.close()

    // Opening through the repo layer runs 0008 on the populated copy.
    const db = Database.open({ file: dbFile })
    try {
      const raw = new Sqlite(dbFile)
      try {
        expect(
          raw
            .prepare<[], CountRow>(
              "SELECT count(*) AS n FROM notification_channels WHERE type <> 'resend'",
            )
            .get()!.n,
        ).toBe(0)
        expect(
          raw.prepare<[], CountRow>('SELECT count(*) AS n FROM notification_channels').get()!.n,
        ).toBe(1)
        // Routing survives for the kept channel only — legacy and dangling rows are gone.
        expect(
          raw.prepare<[], CountRow>('SELECT count(*) AS n FROM monitor_notifications').get()!.n,
        ).toBe(1)
        expect(
          raw.prepare<[], { channel_id: number }>('SELECT channel_id FROM monitor_notifications')
            .get()!.channel_id,
        ).toBe(keepId)
        expect(
          raw.prepare<[], CountRow>('SELECT count(*) AS n FROM status_subscriptions').get()!.n,
        ).toBe(1)
        expect(
          raw
            .prepare<[], { channel_id: number }>('SELECT channel_id FROM status_subscriptions')
            .get()!.channel_id,
        ).toBe(keepId)
      } finally {
        raw.close()
      }

      // The surviving channel is intact through the repo layer.
      expect(db.listChannels().map((row) => row.name)).toEqual(['keep'])
    } finally {
      db.close()
    }

    // Re-opening an already-pruned database is a no-op, not an error.
    const reopened = Database.open({ file: dbFile })
    expect(reopened.listChannels()).toHaveLength(1)
    reopened.close()
  })

  it('leaves fresh databases without legacy channels', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptime-fresh-'))
    tempDirs.push(dir)
    const dbFile = join(dir, 'uptime.db')
    const db = Database.open({ file: dbFile })
    try {
      expect(db.listChannels()).toEqual([])
    } finally {
      db.close()
    }
  })
})
