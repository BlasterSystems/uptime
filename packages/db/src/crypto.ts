import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM secret box (ADR-0002 §3). Payload format:
 * `v1:<iv:b64url>:<tag:b64url>:<ciphertext:b64url>`.
 */
export class SecretBox {
  private readonly key: Buffer
  private readonly ephemeral: boolean

  constructor(rawKey: string | undefined) {
    if (rawKey === undefined || rawKey.length === 0) {
      this.key = randomBytes(32)
      this.ephemeral = true
      return
    }
    const key = SecretBox.parseKey(rawKey)
    if (!key) {
      throw new Error(
        'ENCRYPTION_KEY must be 32 bytes: 64 hex chars, 44-char base64url/base64, or 32 raw bytes',
      )
    }
    this.key = key
    this.ephemeral = false
  }

  /** True when no ENCRYPTION_KEY was provided — secrets cannot survive restarts. */
  get isEphemeral(): boolean {
    return this.ephemeral
  }

  /** Generates a fresh 32-byte hex key (for docs / first-run). */
  static generateKey(): string {
    return randomBytes(32).toString('hex')
  }

  static parseKey(raw: string): Buffer | null {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
    if (raw.length === 44 && /^[A-Za-z0-9_-]{43}=$/.test(raw)) {
      return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    }
    if (raw.length === 44 && /^[A-Za-z0-9+/]{43}=$/.test(raw)) return Buffer.from(raw, 'base64')
    if (Buffer.byteLength(raw, 'utf8') === 32) return Buffer.from(raw, 'utf8')
    return null
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`
  }

  decrypt(payload: string): string {
    const [version, ivB64, tagB64, ctB64] = payload.split(':')
    if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) {
      throw new Error('invalid encrypted payload')
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value))
  }

  decryptJson<T>(payload: string): T {
    return JSON.parse(this.decrypt(payload)) as T
  }

  /** sha256 hex — for API keys and push tokens (never store raw). */
  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  /** Random URL-safe token. */
  token(bytes = 32): string {
    return randomBytes(bytes).toString('base64url')
  }
}
