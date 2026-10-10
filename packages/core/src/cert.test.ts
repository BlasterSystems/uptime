import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import type { Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getCertExpiryDays } from './cert.js'
import { parseMonitorConfig } from './config.js'
import { runHttpCheck } from './http.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

interface CertPair {
  key: string
  cert: string
}

// The TLS fixtures are self-signed, so `fetch` must skip chain verification.
// `tls.connect` reads NODE_TLS_REJECT_UNAUTHORIZED per connection, so setting it
// for this file is enough; the probe under test opts out of verification itself.
let previousTlsReject: string | undefined
let validCert: CertPair
let expiredCert: CertPair
const servers: Array<HttpServer | NetServer> = []
const tempDirs: string[] = []

/** Generate a self-signed RSA pair with the `openssl` CLI (present on macOS and CI). */
function generateSelfSignedCert(name: string, validity: string[]): CertPair {
  const dir = mkdtempSync(join(tmpdir(), 'uptime-cert-'))
  tempDirs.push(dir)
  const key = join(dir, `${name}-key.pem`)
  const cert = join(dir, `${name}-cert.pem`)
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ...validity,
    ],
    { stdio: 'ignore' },
  )
  return { key, cert }
}

/**
 * Sign a key with `openssl ca -startdate/-enddate`, which backdates the
 * certificate on every OpenSSL version (`req -not_before/-not_after` only
 * exists since 3.4).
 */
function generateExpiredCert(name: string): CertPair {
  const dir = mkdtempSync(join(tmpdir(), 'uptime-cert-'))
  tempDirs.push(dir)
  const key = join(dir, `${name}-key.pem`)
  const csr = join(dir, `${name}.csr`)
  const cert = join(dir, `${name}-cert.pem`)
  execFileSync(
    'openssl',
    [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      csr,
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'ignore' },
  )

  const caDir = join(dir, 'ca')
  mkdirSync(join(caDir, 'newcerts'), { recursive: true })
  writeFileSync(join(caDir, 'index.txt'), '')
  writeFileSync(join(caDir, 'serial'), '1000\n')
  const caConfig = join(dir, 'ca.cnf')
  writeFileSync(
    caConfig,
    [
      '[ ca ]',
      'default_ca = CA_default',
      '[ CA_default ]',
      `database = ${caDir}/index.txt`,
      `new_certs_dir = ${caDir}/newcerts`,
      `serial = ${caDir}/serial`,
      'default_md = sha256',
      'policy = policy_any',
      'unique_subject = no',
      '[ policy_any ]',
      'commonName = supplied',
    ].join('\n'),
  )
  execFileSync(
    'openssl',
    [
      'ca',
      '-batch',
      '-config',
      caConfig,
      '-selfsign',
      '-keyfile',
      key,
      '-in',
      csr,
      '-out',
      cert,
      '-startdate',
      '200101000000Z',
      '-enddate',
      '210101000000Z',
      '-notext',
      '-md',
      'sha256',
    ],
    { stdio: 'ignore' },
  )
  return { key, cert }
}

/** Start `server` on an ephemeral port and return the base URL for `protocol`. */
async function startServer(
  server: HttpServer | NetServer,
  protocol: 'http' | 'https',
): Promise<string> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind an ephemeral TCP port')
  }
  return `${protocol}://127.0.0.1:${address.port}`
}

/** Start a plain-HTTP fixture server. */
async function listenHttp(handler: Handler): Promise<string> {
  return startServer(
    createHttpServer((req, res) => {
      req.on('error', () => {})
      res.on('error', () => {})
      handler(req, res)
    }),
    'http',
  )
}

/** Start a TLS fixture server presenting `pair`. */
async function listenHttps(
  pair: CertPair,
  handler: Handler = (_req, res) => res.end('ok'),
): Promise<string> {
  return startServer(
    createHttpsServer(
      { key: readFileSync(pair.key), cert: readFileSync(pair.cert) },
      (req, res) => {
        req.on('error', () => {})
        res.on('error', () => {})
        handler(req, res)
      },
    ),
    'https',
  )
}

/** Start a TCP server that accepts connections but never answers the TLS handshake. */
async function listenStalledTls(): Promise<string> {
  return startServer(
    createNetServer((socket) => {
      socket.on('error', () => {})
      // Drain the ClientHello so the socket closes once the client gives up on
      // the handshake; an unread buffer would keep `server.close()` waiting.
      socket.on('data', () => {})
    }),
    'https',
  )
}

/** Reserve an ephemeral port, then release it so connecting gets ECONNREFUSED. */
async function closedPort(): Promise<number> {
  const server = createNetServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind an ephemeral TCP port')
  }
  server.close()
  await once(server, 'close')
  return address.port
}

beforeAll(() => {
  validCert = generateSelfSignedCert('valid', ['-days', '30'])
  expiredCert = generateExpiredCert('expired')
  previousTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
})

afterAll(async () => {
  if (previousTlsReject === undefined) {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  } else {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsReject
  }
  await Promise.all(
    servers.splice(0).map(async (server) => {
      if ('closeAllConnections' in server) server.closeAllConnections()
      server.close()
      await once(server, 'close')
    }),
  )
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('getCertExpiryDays', () => {
  it('returns the days remaining for a local https server', async () => {
    const url = await listenHttps(validCert)

    const days = await getCertExpiryDays(url, 2000)

    expect(days).not.toBeNull()
    expect(days).toBeGreaterThanOrEqual(0)
    expect(days).toBeLessThanOrEqual(30)
  })

  it('returns a negative count once the certificate has expired', async () => {
    const url = await listenHttps(expiredCert)

    const days = await getCertExpiryDays(url, 2000)

    expect(days).not.toBeNull()
    expect(days).toBeLessThan(0)
  })

  it('returns null when the TLS handshake stalls past the timeout', async () => {
    const url = await listenStalledTls()

    const days = await getCertExpiryDays(url, 100)

    expect(days).toBeNull()
  })

  it('returns null when the connection is refused', async () => {
    const port = await closedPort()

    const days = await getCertExpiryDays(`https://127.0.0.1:${port}`, 1000)

    expect(days).toBeNull()
  })

  it('returns null for non-https and unparseable URLs', async () => {
    expect(await getCertExpiryDays('http://example.com')).toBeNull()
    expect(await getCertExpiryDays('not a url')).toBeNull()
    expect(await getCertExpiryDays('ftp://example.com')).toBeNull()
  })
})

describe('runHttpCheck certificate expiry', () => {
  it('reports down when the certificate expires below the configured minimum', async () => {
    const url = await listenHttps(validCert)
    const calls: Array<[string, number | undefined]> = []

    const result = await runHttpCheck(
      parseMonitorConfig('http', { url, timeoutMs: 2000, certExpiryDays: 30 }),
      undefined,
      {
        certProbe: async (probedUrl, timeoutMs) => {
          calls.push([probedUrl, timeoutMs])
          return 12
        },
      },
    )

    expect(result.status).toBe('down')
    expect(result.responseSnippet).toBe('certificate expires in 12 days (min 30)')
    expect(calls).toEqual([[url, 2000]])
  })

  it('stays up when the certificate expires exactly at the minimum', async () => {
    const url = await listenHttps(validCert)

    const result = await runHttpCheck(
      parseMonitorConfig('http', { url, timeoutMs: 2000, certExpiryDays: 30 }),
      undefined,
      { certProbe: async () => 30 },
    )

    expect(result.status).toBe('up')
    expect(result.responseSnippet).toBe('ok')
  })

  it('stays up when the expiry cannot be read', async () => {
    const url = await listenHttps(validCert)

    const result = await runHttpCheck(
      parseMonitorConfig('http', { url, timeoutMs: 2000, certExpiryDays: 30 }),
      undefined,
      { certProbe: async () => null },
    )

    expect(result.status).toBe('up')
    expect(result.responseSnippet).toBe('ok')
  })

  it('does not probe when certExpiryDays is not configured', async () => {
    const url = await listenHttps(validCert)

    const result = await runHttpCheck(
      parseMonitorConfig('http', { url, timeoutMs: 2000 }),
      undefined,
      {
        certProbe: async () => {
          throw new Error('probe must not run')
        },
      },
    )

    expect(result.status).toBe('up')
  })

  it('does not probe plain http URLs', async () => {
    const url = await listenHttp((_req, res) => res.end('ok'))

    const result = await runHttpCheck(
      parseMonitorConfig('http', { url, timeoutMs: 2000, certExpiryDays: 30 }),
      undefined,
      {
        certProbe: async () => {
          throw new Error('probe must not run')
        },
      },
    )

    expect(result.status).toBe('up')
  })

  it('reports the original failure reason when the check is already down', async () => {
    const url = await listenHttps(validCert, (_req, res) => {
      res.writeHead(503)
      res.end('unavailable')
    })

    const result = await runHttpCheck(
      parseMonitorConfig('http', { url, timeoutMs: 2000, certExpiryDays: 30 }),
      undefined,
      {
        certProbe: async () => {
          throw new Error('probe must not run')
        },
      },
    )

    expect(result.status).toBe('down')
    expect(result.responseSnippet).toBe('status 503 not accepted (expected 200-299)')
  })

  it('fails end to end on an expired certificate', async () => {
    const url = await listenHttps(expiredCert)

    const result = await runHttpCheck(
      parseMonitorConfig('http', { url, timeoutMs: 2000, certExpiryDays: 30 }),
    )

    expect(result.status).toBe('down')
    expect(result.responseSnippet).toMatch(/^certificate expires in -\d+ days \(min 30\)$/)
  })

  it('stays up end to end on a fresh certificate', async () => {
    const url = await listenHttps(validCert)

    const result = await runHttpCheck(
      parseMonitorConfig('http', { url, timeoutMs: 2000, certExpiryDays: 1 }),
    )

    expect(result.status).toBe('up')
    expect(result.responseSnippet).toBe('ok')
  })
})
