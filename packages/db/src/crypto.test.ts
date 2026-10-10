import { describe, expect, it } from 'vitest'
import { SecretBox } from './crypto.js'

const KEY_HEX = 'a'.repeat(64)
const KEY_B64URL = 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=' // 32 'a' bytes
const KEY_RAW = Buffer.from('b'.repeat(32), 'utf8').toString('utf8')

describe('SecretBox', () => {
  it('roundtrips encrypt/decrypt', () => {
    const box = new SecretBox(KEY_HEX)
    const payload = box.encrypt('hello secret')
    expect(payload.startsWith('v1:')).toBe(true)
    expect(box.decrypt(payload)).toBe('hello secret')
  })

  it('roundtrips JSON values', () => {
    const box = new SecretBox(KEY_HEX)
    const value = { botToken: '123', chatId: 'x' }
    const payload = box.encryptJson(value)
    expect(box.decryptJson(payload)).toEqual(value)
  })

  it('rejects tampered ciphertext', () => {
    const box = new SecretBox(KEY_HEX)
    const payload = box.encrypt('data')
    const parts = payload.split(':')
    // Flip the first ciphertext character: always a different payload (unlike
    // rewriting the trailing characters, which can be a no-op).
    const ciphertext = parts[3] ?? ''
    parts[3] = (ciphertext.startsWith('A') ? 'B' : 'A') + ciphertext.slice(1)
    expect(() => box.decrypt(parts.join(':'))).toThrow()
  })

  it('rejects malformed payloads and wrong keys', () => {
    const box = new SecretBox(KEY_HEX)
    expect(() => box.decrypt('garbage')).toThrow()
    const other = new SecretBox('c'.repeat(64))
    const payload = box.encrypt('data')
    expect(() => other.decrypt(payload)).toThrow()
  })

  it('accepts base64url, base64 and raw byte keys', () => {
    expect(new SecretBox(KEY_B64URL).encrypt('x')).toMatch(/^v1:/)
    expect(new SecretBox(KEY_B64URL.replace(/-/g, '+').replace(/_/g, '/')).encrypt('x')).toMatch(
      /^v1:/,
    )
    expect(new SecretBox(KEY_RAW).encrypt('x')).toMatch(/^v1:/)
  })

  it('rejects invalid keys', () => {
    expect(() => new SecretBox('short')).toThrow(/ENCRYPTION_KEY/)
    expect(() => new SecretBox('g'.repeat(64))).toThrow(/ENCRYPTION_KEY/)
  })

  it('is ephemeral without a key', () => {
    const box = new SecretBox(undefined)
    expect(box.isEphemeral).toBe(true)
    const empty = new SecretBox('')
    expect(empty.isEphemeral).toBe(true)
    const keyed = new SecretBox(KEY_HEX)
    expect(keyed.isEphemeral).toBe(false)
    expect(SecretBox.generateKey()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashes tokens and generates url-safe tokens', () => {
    const box = new SecretBox(KEY_HEX)
    expect(box.hash('token')).toBe(box.hash('token'))
    expect(box.hash('token')).toMatch(/^[0-9a-f]{64}$/)
    const token = box.token(24)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token.length).toBeGreaterThan(20)
  })

  it('parses keys consistently', () => {
    expect(SecretBox.parseKey(KEY_HEX)?.toString('hex')).toBe(KEY_HEX)
    expect(SecretBox.parseKey(KEY_B64URL)?.toString()).toBe('a'.repeat(32))
    expect(SecretBox.parseKey('nope')).toBeNull()
  })
})
