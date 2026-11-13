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

/** Applies migrations 0000–0006 (pre-cut schema, `docker_hosts` present). */
function openPreCutDb(file: string): SqliteConnection {
  const base = mkdtempSync(join(tmpdir(), 'uptime-mig-'))
  tempDirs.push(base)
  const trimmed = join(base, 'drizzle-0006')
  cpSync(DRIZZLE_DIR, trimmed, { recursive: true })
  for (const [tag, idx] of [
    ['0007_free_ironclad', '0007'],
    ['0008_prune_notification_channels', '0008'],
  ]) {
    rmSync(join(trimmed, `${tag}.sql`))
    rmSync(join(trimmed, 'meta', `${idx}_snapshot.json`))
  }
  const journalPath = join(trimmed, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ tag: string }>
  }
  journal.entries = journal.entries.filter(
    (entry) => entry.tag !== '0007_free_ironclad' && entry.tag !== '0008_prune_notification_channels',
  )
  writeFileSync(journalPath, JSON.stringify(journal, null, 2))

  const raw = new Sqlite(file)
  raw.pragma('foreign_keys = ON')
  migrate(drizzle(raw), { migrationsFolder: trimmed })
  return raw
}

/** The migration file set is frozen history; the tag is asserted to catch renames. */
const MIGRATION_0007 = '0007_free_ironclad'

interface CountRow {
  n: number
}

describe(`migration ${MIGRATION_0007} (docker cut, ADR-0008)`, () => {
  it('deletes docker monitors with all dependent rows and drops docker_hosts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptime-cut-'))
    tempDirs.push(dir)
    const dbFile = join(dir, 'uptime.db')
    const now = Date.now()

    const pre = openPreCutDb(dbFile)
    pre.exec(`
      INSERT INTO monitors (type, name, config_json, created_at, updated_at)
        VALUES ('docker', 'watched-container', '{"hostUri":"unix:///var/run/docker.sock"}', ${now}, ${now}),
               ('http', 'api', '{"url":"https://example.com"}', ${now}, ${now});
      INSERT INTO docker_hosts (name, uri, tls_ca_enc, created_at, updated_at)
        VALUES ('dockerd', 'tcp://10.0.0.9:2376', 'enc', ${now}, ${now});
      INSERT INTO notification_channels (type, name, config_enc, created_at, updated_at)
        VALUES ('resend', 'ops', 'enc', ${now}, ${now});
      INSERT INTO tags (name, created_at) VALUES ('prod', ${now});
    `)
    const dockerId = pre.prepare<[], { id: number }>("SELECT id FROM monitors WHERE type = 'docker'").get()!.id
    const httpId = pre.prepare<[], { id: number }>("SELECT id FROM monitors WHERE type = 'http'").get()!.id
    const channelId = pre.prepare<[], { id: number }>('SELECT id FROM notification_channels').get()!.id
    const tagId = pre.prepare<[], { id: number }>('SELECT id FROM tags').get()!.id
    pre.exec(`
      INSERT INTO heartbeats (monitor_id, status, latency_ms, time) VALUES
        (${dockerId}, 'down', NULL, ${now}), (${httpId}, 'up', 12, ${now});
      INSERT INTO heartbeats_hourly (monitor_id, hour_bucket, up, down, maintenance, total_ms, count)
        VALUES (${dockerId}, ${now}, 0, 3, 0, 300, 3), (${httpId}, ${now}, 2, 0, 0, 20, 2);
      INSERT INTO heartbeats_daily (monitor_id, day_bucket, up, down, maintenance, total_ms, count)
        VALUES (${dockerId}, ${now}, 0, 3, 0, 300, 3), (${httpId}, ${now}, 2, 0, 0, 20, 2);
      INSERT INTO incidents (monitor_id, opened_at, title) VALUES (${dockerId}, ${now}, 'watched-container is down');
      INSERT INTO monitor_notifications (monitor_id, channel_id) VALUES (${dockerId}, ${channelId}), (${httpId}, ${channelId});
      INSERT INTO monitor_tags (monitor_id, tag_id) VALUES (${dockerId}, ${tagId}), (${httpId}, ${tagId});
    `)
    pre.close()

    // Opening through the repo layer runs 0007 on the populated copy.
    const db = Database.open({ file: dbFile })
    try {
      const raw = new Sqlite(dbFile)
      try {
        const countFor = (sql: string, id: number): number =>
          raw.prepare<[number], CountRow>(sql).get(id)!.n
        expect(
          raw.prepare<[], CountRow>("SELECT count(*) AS n FROM monitors WHERE type = 'docker'")
            .get()!.n,
        ).toBe(0)
        expect(
          raw.prepare<[], CountRow>("SELECT count(*) AS n FROM monitors WHERE type = 'http'")
            .get()!.n,
        ).toBe(1)
        expect(countFor('SELECT count(*) AS n FROM heartbeats WHERE monitor_id = ?', dockerId)).toBe(0)
        expect(countFor('SELECT count(*) AS n FROM heartbeats WHERE monitor_id = ?', httpId)).toBe(1)
        expect(countFor('SELECT count(*) AS n FROM incidents WHERE monitor_id = ?', dockerId)).toBe(0)
        expect(
          countFor('SELECT count(*) AS n FROM monitor_notifications WHERE monitor_id = ?', dockerId),
        ).toBe(0)
        expect(
          countFor('SELECT count(*) AS n FROM monitor_notifications WHERE monitor_id = ?', httpId),
        ).toBe(1)
        expect(countFor('SELECT count(*) AS n FROM monitor_tags WHERE monitor_id = ?', dockerId)).toBe(0)
        expect(countFor('SELECT count(*) AS n FROM monitor_tags WHERE monitor_id = ?', httpId)).toBe(1)
        expect(
          countFor('SELECT count(*) AS n FROM heartbeats_hourly WHERE monitor_id = ?', dockerId),
        ).toBe(0)
        expect(
          countFor('SELECT count(*) AS n FROM heartbeats_hourly WHERE monitor_id = ?', httpId),
        ).toBe(1)
        expect(
          countFor('SELECT count(*) AS n FROM heartbeats_daily WHERE monitor_id = ?', dockerId),
        ).toBe(0)
        expect(
          countFor('SELECT count(*) AS n FROM heartbeats_daily WHERE monitor_id = ?', httpId),
        ).toBe(1)
        expect(
          raw.prepare<[], CountRow>(
            "SELECT count(*) AS n FROM sqlite_master WHERE name = 'docker_hosts'",
          ).get()!.n,
        ).toBe(0)
      } finally {
        raw.close()
      }

      // The surviving monitor is intact through the repo layer.
      expect(db.listMonitors().map((row) => row.name)).toEqual(['api'])
    } finally {
      db.close()
    }

    // Re-opening an already-cut database is a no-op, not an error.
    const reopened = Database.open({ file: dbFile })
    expect(reopened.listMonitors()).toHaveLength(1)
    reopened.close()
  })

  it('leaves fresh databases without docker_hosts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptime-fresh-'))
    tempDirs.push(dir)
    const dbFile = join(dir, 'uptime.db')
    const db = Database.open({ file: dbFile })
    try {
      expect(db.listMonitors()).toEqual([])
      const raw = new Sqlite(dbFile)
      try {
        expect(
          raw.prepare<[], CountRow>(
            "SELECT count(*) AS n FROM sqlite_master WHERE name = 'docker_hosts'",
          ).get()!.n,
        ).toBe(0)
      } finally {
        raw.close()
      }
    } finally {
      db.close()
    }
  })
})
