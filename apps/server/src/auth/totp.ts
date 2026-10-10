import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Hand-rolled RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s step) with the RFC 4226
 * §5.3 dynamic truncation. Kept dependency-free: authenticator apps only need
 * the SHA1/6/30 profile, and the surface stays small enough to audit.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export const TOTP_STEP_MS = 30_000
export const TOTP_DIGITS = 6
/** Accepted clock drift: the previous and next step's codes also verify. */
export const TOTP_WINDOW = 1

/** RFC 4648 base32 decode (padding optional, case-insensitive, spaces ignored). */
export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (cleaned.length === 0) throw new Error('empty base32 input')
  let buffer = 0
  let bits = 0
  const bytes: number[] = []
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) throw new Error(`invalid base32 character: ${char}`)
    buffer = (buffer << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >>> bits) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

/** RFC 4648 base32 encode, unpadded (the format authenticator apps expect). */
export function base32Encode(input: Buffer): string {
  let buffer = 0
  let bits = 0
  let out = ''
  for (const byte of input) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32_ALPHABET[(buffer >>> bits) & 0x1f]
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f]
  return out
}

/** 20 random bytes → 32-char base32 secret (RFC 4226 §4 recommended size). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/** RFC 6238 code for `timeMs` (defaults to now). */
export function totpCode(secret: string, timeMs: number = Date.now()): string {
  const counter = Math.floor(timeMs / TOTP_STEP_MS)
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)
  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0')
}

/** True when `code` matches any of the ±TOTP_WINDOW steps around `timeMs`. */
export function verifyTotp(secret: string, code: string, timeMs: number = Date.now()): boolean {
  const normalized = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(normalized)) return false
  const expected = Buffer.from(normalized)
  for (let drift = -TOTP_WINDOW; drift <= TOTP_WINDOW; drift += 1) {
    const candidate = Buffer.from(totpCode(secret, timeMs + drift * TOTP_STEP_MS))
    if (timingSafeEqual(candidate, expected)) return true
  }
  return false
}

/** `otpauth://` URI for authenticator apps (issuer + account label). */
export function otpauthUrl(account: string, secret: string, issuer = 'Uptime'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_MS / 1000),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}
