import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUrl,
  totpCode,
  verifyTotp,
} from './totp.js'

/** RFC 6238 Appendix B secret: ASCII "12345678901234567890". */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

/** RFC 6238 Appendix B vectors, truncated to the 6 digits we emit. */
const RFC_VECTORS: Array<[number, string]> = [
  [59_000, '287082'],
  [1_111_111_109_000, '081804'],
  [1_111_111_111_000, '050471'],
  [1_234_567_890_000, '005924'],
  [2_000_000_000_000, '279037'],
  [20_000_000_000_000, '353130'],
]

describe('base32', () => {
  it('encodes the RFC 6238 test secret', () => {
    expect(base32Encode(Buffer.from('12345678901234567890', 'ascii'))).toBe(RFC_SECRET)
  })

  it('round-trips arbitrary bytes', () => {
    const bytes = randomBytes(32)
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true)
  })

  it('accepts lowercase, spaces and padding', () => {
    const lower =
      RFC_SECRET.toLowerCase()
        .match(/.{1,4}/g)!
        .join(' ') + '===='
    expect(base32Decode(lower).toString('ascii')).toBe('12345678901234567890')
  })

  it('rejects invalid characters', () => {
    expect(() => base32Decode('ABC1')).toThrow(/invalid base32 character/)
  })
})

describe('totpCode', () => {
  it('matches the RFC 6238 vectors', () => {
    for (const [timeMs, expected] of RFC_VECTORS) {
      expect(totpCode(RFC_SECRET, timeMs)).toBe(expected)
    }
  })

  it('changes every 30 s step', () => {
    const code = totpCode(RFC_SECRET, 59_000)
    expect(totpCode(RFC_SECRET, 60_000)).not.toBe(code)
    expect(totpCode(RFC_SECRET, 89_000)).toBe(totpCode(RFC_SECRET, 60_000))
  })
})

describe('verifyTotp', () => {
  const now = 1_700_000_000_000

  it('accepts the current step and ±1 window', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now), now)).toBe(true)
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 30_000), now)).toBe(true)
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now + 30_000), now)).toBe(true)
  })

  it('rejects codes outside the window', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now + 60_000), now)).toBe(false)
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 60_000), now)).toBe(false)
  })

  it('rejects malformed codes', () => {
    expect(verifyTotp(RFC_SECRET, '12345', now)).toBe(false)
    expect(verifyTotp(RFC_SECRET, '1234567', now)).toBe(false)
    expect(verifyTotp(RFC_SECRET, 'abcdef', now)).toBe(false)
    expect(verifyTotp(RFC_SECRET, '', now)).toBe(false)
  })
})

describe('generateTotpSecret', () => {
  it('emits 32 base32 characters (160 bits)', () => {
    const secret = generateTotpSecret()
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(generateTotpSecret()).not.toBe(secret)
  })
})

describe('otpauthUrl', () => {
  it('builds an authenticator-compatible URI', () => {
    const url = new URL(otpauthUrl('admin@example.com', RFC_SECRET))
    expect(url.protocol).toBe('otpauth:')
    expect(url.host).toBe('totp')
    expect(decodeURIComponent(url.pathname)).toBe('/Uptime:admin@example.com')
    expect(url.searchParams.get('secret')).toBe(RFC_SECRET)
    expect(url.searchParams.get('issuer')).toBe('Uptime')
    expect(url.searchParams.get('algorithm')).toBe('SHA1')
    expect(url.searchParams.get('digits')).toBe('6')
    expect(url.searchParams.get('period')).toBe('30')
  })
})
