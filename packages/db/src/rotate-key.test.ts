import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SecretBox } from './crypto.js'
import { Database } from './index.js'
import { rotateEncryptionKey, runRotateCli } from './rotate-key.js'

const FROM_KEY = 'a'.repeat(64)
const TO_KEY = 'b'.repeat(64)
const OTHER_KEY = 'c'.repeat(64)

const tempDirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Seeded {
  dbFile: string
  monitorId: number
  dockerHostId: number
  userId: number
  channelId: number
  pushToken: string
}

/** One database with every encrypted column seeded, encrypted with FROM_KEY. */
function seed(): Seeded {
  const dir = mkdtempSync(join(tmpdir(), 'uptime-rotate-'))
  tempDirs.push(dir)
  const dbFile = join(dir, 'uptime.db')
  const db = Database.open({ file: dbFile })
  const from = new SecretBox(FROM_KEY)
  const other = new SecretBox(OTHER_KEY)

  const monitor = db.createMonitor({
    type: 'push',
    name: 'agent',
    intervalS: 60,
    retries: 1,
    retryIntervalS: 60,
    config: { graceSeconds: 60 },
  })
  const pushToken = 'push-token-123'
  db.setPushToken(monitor.id, pushToken, from.encrypt(pushToken))

  const dockerHost = db.createDockerHost({
    name: 'dockerd',
    uri: 'tcp://10.0.0.9:2376',
    tlsCaEnc: from.encrypt('CA'),
    tlsCertEnc: from.encrypt('CERT'),
    tlsKeyEnc: from.encrypt('KEY'),
  })

  const channel = db.createChannel({
    type: 'telegram',
    name: 'ops',
    configEnc: from.encryptJson({ botToken: 'bot' }),
  })
  // A second channel written with a key rotation does not know about: it must
  // come back untouched and counted as failed.
  db.createChannel({ type: 'ntfy', name: 'legacy', configEnc: other.encrypt('legacy') })

  const user = db.createUser({ email: 'admin@example.com', passwordHash: 'hash' })
  db.updateUser(user.id, {
    totpSecretEnc: from.encrypt('TOTP'),
    recoveryCodesEnc: from.encryptJson(['r1', 'r2']),
  })

  db.close()
  return {
    dbFile,
    monitorId: monitor.id,
    dockerHostId: dockerHost.id,
    userId: user.id,
    channelId: channel.id,
    pushToken,
  }
}

describe('rotateEncryptionKey', () => {
  it('re-encrypts every encrypted column and reports row counts', async () => {
    const seeded = seed()

    const result = await rotateEncryptionKey({
      dbFile: seeded.dbFile,
      fromKey: FROM_KEY,
      toKey: TO_KEY,
    })

    expect(result.failed).toBe(1) // the legacy channel written with OTHER_KEY
    expect(result.reencrypted).toEqual([
      { table: 'notification_channels', column: 'config_enc', rows: 1 },
      { table: 'users', column: 'totp_secret_enc', rows: 1 },
      { table: 'users', column: 'recovery_codes_enc', rows: 1 },
      { table: 'push_tokens', column: 'token_enc', rows: 1 },
      { table: 'docker_hosts', column: 'tls_ca_enc', rows: 1 },
      { table: 'docker_hosts', column: 'tls_cert_enc', rows: 1 },
      { table: 'docker_hosts', column: 'tls_key_enc', rows: 1 },
    ])

    const to = new SecretBox(TO_KEY)
    const db = Database.open({ file: seeded.dbFile })
    try {
      const pushTokenEnc = db.getPushToken(seeded.monitorId)
      expect(to.decrypt(pushTokenEnc ?? '')).toBe(seeded.pushToken)
      expect(() => new SecretBox(FROM_KEY).decrypt(pushTokenEnc ?? '')).toThrow()

      const host = db.getDockerHost(seeded.dockerHostId)
      expect(to.decrypt(host?.tlsCaEnc ?? '')).toBe('CA')
      expect(to.decrypt(host?.tlsCertEnc ?? '')).toBe('CERT')
      expect(to.decrypt(host?.tlsKeyEnc ?? '')).toBe('KEY')

      const channel = db.getChannel(seeded.channelId)
      expect(to.decryptJson(channel?.configEnc ?? '')).toEqual({ botToken: 'bot' })

      const user = db.getUser(seeded.userId)
      expect(to.decrypt(user?.totpSecretEnc ?? '')).toBe('TOTP')
      expect(to.decryptJson(user?.recoveryCodesEnc ?? '')).toEqual(['r1', 'r2'])

      const legacy = db.listChannels().find((row) => row.name === 'legacy')
      expect(new SecretBox(OTHER_KEY).decrypt(legacy?.configEnc ?? '')).toBe('legacy')
    } finally {
      db.close()
    }
  })

  it('leaves rows alone and reports them when the old key does not open them', async () => {
    const seeded = seed()
    await rotateEncryptionKey({ dbFile: seeded.dbFile, fromKey: FROM_KEY, toKey: TO_KEY })

    // Rotating again with the same from-key: every value now fails to decrypt
    // (2 channels + 2 user columns + 1 push token + 3 docker TLS values).
    const again = await rotateEncryptionKey({
      dbFile: seeded.dbFile,
      fromKey: FROM_KEY,
      toKey: OTHER_KEY,
    })
    expect(again.reencrypted).toEqual([])
    expect(again.failed).toBe(8)
  })

  it('rejects a missing database file instead of creating one', async () => {
    await expect(
      rotateEncryptionKey({ dbFile: '/nope/missing.db', fromKey: FROM_KEY, toKey: TO_KEY }),
    ).rejects.toThrowError(/database file not found/)
  })
})

describe('runRotateCli', () => {
  it('rotates and prints the JSON report, returning 0', async () => {
    const seeded = seed()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const code = await runRotateCli(['--db', seeded.dbFile, '--from', FROM_KEY, '--to', TO_KEY])

    expect(code).toBe(0)
    const printed = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      reencrypted: Array<{ table: string; column: string; rows: number }>
      failed: number
    }
    expect(printed.failed).toBe(1)
    expect(printed.reencrypted).toHaveLength(7)
    expect(printed.reencrypted).toContainEqual({
      table: 'notification_channels',
      column: 'config_enc',
      rows: 1,
    })

    const db = Database.open({ file: seeded.dbFile })
    try {
      expect(new SecretBox(TO_KEY).decrypt(db.getPushToken(seeded.monitorId) ?? '')).toBe(
        seeded.pushToken,
      )
    } finally {
      db.close()
    }
  })

  it('prints usage for --help and missing/invalid arguments', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await runRotateCli(['--help'])).toBe(0)
    expect(String(log.mock.calls[0]?.[0])).toContain('Usage: rotate-key')

    expect(await runRotateCli([])).toBe(1)
    expect(await runRotateCli(['--db', 'x.db', '--from', FROM_KEY])).toBe(1)
    expect(await runRotateCli(['--db', 'x.db', '--from', FROM_KEY, '--bogus', 'y'])).toBe(1)
    expect(await runRotateCli(['--db', '--to', TO_KEY])).toBe(1)
    for (const call of error.mock.calls) {
      expect(String(call[0])).toContain('Usage: rotate-key')
    }
  })

  it('accepts a pnpm/npm `--` separator and reports rotation failures on stderr', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const code = await runRotateCli([
      '--',
      '--db',
      '/nope/missing.db',
      '--from',
      FROM_KEY,
      '--to',
      TO_KEY,
    ])
    expect(code).toBe(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('database file not found')
  })

  it('reports rotation failures on stderr and returns 1', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const code = await runRotateCli([
      '--db',
      '/nope/missing.db',
      '--from',
      FROM_KEY,
      '--to',
      TO_KEY,
    ])

    expect(code).toBe(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('database file not found')
  })
})
