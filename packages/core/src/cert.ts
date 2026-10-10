import { isIP } from 'node:net'
import { connect } from 'node:tls'

const MS_PER_DAY = 86_400_000

/**
 * Days until the TLS certificate presented by an `https:` `url` expires,
 * floored to whole days and negative once the certificate is past its
 * `notAfter` date (SPEC §3 `certExpiryDays`).
 *
 * Resolves `null` — never rejects — for non-https URLs and whenever the expiry
 * cannot be read: DNS failures, refused connections, handshake errors, a peer
 * without a certificate, or no handshake within `timeoutMs` (default 5000).
 * Certificate validation is deliberately disabled so expired and otherwise
 * untrusted (e.g. self-signed) certificates can still be inspected.
 */
export async function getCertExpiryDays(url: string, timeoutMs = 5000): Promise<number | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null

  // `URL.hostname` keeps the brackets on IPv6 literals; `net`/`tls` want them bare.
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  const port = parsed.port === '' ? 443 : Number(parsed.port)

  return new Promise<number | null>((resolve) => {
    const socket = connect({
      host,
      port,
      // RFC 6066 forbids IP literals in SNI (Node warns with DEP0123), so only
      // hostnames are announced.
      servername: isIP(host) === 0 ? host : undefined,
      rejectUnauthorized: false,
    })

    let settled = false
    const finish = (days: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(days)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)

    socket.on('error', () => finish(null))
    socket.once('secureConnect', () => {
      const notAfter = Date.parse(socket.getPeerCertificate().valid_to)
      finish(Number.isNaN(notAfter) ? null : Math.floor((notAfter - Date.now()) / MS_PER_DAY))
    })
  })
}
