import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { parseMonitorConfig } from './config.js'

describe('parseMonitorConfig tcp', () => {
  it('applies the timeout default and strips unknown keys', () => {
    expect(parseMonitorConfig('tcp', { host: 'db.internal', port: 5432, bogus: true })).toEqual({
      host: 'db.internal',
      port: 5432,
      timeoutMs: 10_000,
    })
  })

  it('keeps a fully specified config intact', () => {
    const raw = {
      host: '127.0.0.1',
      port: 9000,
      timeoutMs: 2500,
      payload: 'PING\n',
      expectResponse: 'PONG',
    }
    expect(parseMonitorConfig('tcp', raw)).toEqual(raw)
  })

  it('rejects invalid hosts, ports and timeouts', () => {
    const invalids: Array<[string, unknown]> = [
      ['missing host', { port: 5432 }],
      ['leading dash host', { host: '-c', port: 5432 }],
      ['whitespace host', { host: 'two words', port: 5432 }],
      ['missing port', { host: 'db.internal' }],
      ['port 0', { host: 'db.internal', port: 0 }],
      ['port above 65535', { host: 'db.internal', port: 65_536 }],
      ['zero timeout', { host: 'db.internal', port: 5432, timeoutMs: 0 }],
    ]
    for (const [label, raw] of invalids) {
      expect(() => parseMonitorConfig('tcp', raw), label).toThrowError(ZodError)
    }
  })
})

describe('parseMonitorConfig dns', () => {
  it('defaults port and timeout and strips unknown keys', () => {
    expect(parseMonitorConfig('dns', { host: 'example.com', recordType: 'A', bogus: 1 })).toEqual({
      host: 'example.com',
      recordType: 'A',
      port: 53,
      timeoutMs: 10_000,
    })
  })

  it('keeps a fully specified config intact', () => {
    const raw = {
      host: 'example.com',
      resolver: '192.0.2.53',
      port: 5353,
      recordType: 'MX',
      expectedValue: 'mail.example.com',
      timeoutMs: 2000,
    }
    expect(parseMonitorConfig('dns', raw)).toEqual(raw)
  })

  it('rejects unknown record types and invalid fields', () => {
    const invalids: Array<[string, unknown]> = [
      ['missing recordType', { host: 'example.com' }],
      ['unknown recordType', { host: 'example.com', recordType: 'SOA' }],
      ['port 0', { host: 'example.com', recordType: 'A', port: 0 }],
      ['empty resolver', { host: 'example.com', recordType: 'A', resolver: '' }],
    ]
    for (const [label, raw] of invalids) {
      expect(() => parseMonitorConfig('dns', raw), label).toThrowError(ZodError)
    }
  })
})

describe('parseMonitorConfig icmp', () => {
  it('defaults timeoutMs and packetCount', () => {
    expect(parseMonitorConfig('icmp', { host: '10.0.0.1' })).toEqual({
      host: '10.0.0.1',
      timeoutMs: 5000,
      packetCount: 3,
    })
  })

  it('keeps explicit packet counts from 1 to 10', () => {
    for (const packetCount of [1, 10]) {
      expect(parseMonitorConfig('icmp', { host: '10.0.0.1', packetCount }).packetCount).toBe(
        packetCount,
      )
    }
  })

  it('rejects out-of-range packet counts', () => {
    for (const packetCount of [0, 11, 1.5]) {
      expect(
        () => parseMonitorConfig('icmp', { host: '10.0.0.1', packetCount }),
        String(packetCount),
      ).toThrowError(ZodError)
    }
  })
})

describe.each(['postgres', 'mysql', 'mssql'] as const)('parseMonitorConfig %s', (type) => {
  it('defaults query and timeout and strips unknown keys', () => {
    expect(
      parseMonitorConfig(type, { connectionString: 'driver://user:pass@127.0.0.1:1/db', bogus: 1 }),
    ).toEqual({
      connectionString: 'driver://user:pass@127.0.0.1:1/db',
      timeoutMs: 10_000,
      query: 'SELECT 1',
    })
  })

  it('keeps a custom query and timeout', () => {
    const raw = {
      connectionString: 'driver://127.0.0.1:1/db',
      timeoutMs: 2500,
      query: 'SELECT count(*) FROM events',
    }
    expect(parseMonitorConfig(type, raw)).toEqual(raw)
  })

  it('rejects an empty connection string', () => {
    expect(() => parseMonitorConfig(type, { connectionString: '' })).toThrowError(ZodError)
  })
})

describe('parseMonitorConfig mongodb', () => {
  it('applies the timeout default and strips unknown keys', () => {
    expect(
      parseMonitorConfig('mongodb', { connectionString: 'mongodb://127.0.0.1:1/db', bogus: 1 }),
    ).toEqual({ connectionString: 'mongodb://127.0.0.1:1/db', timeoutMs: 10_000 })
  })

  it('rejects an empty connection string', () => {
    expect(() => parseMonitorConfig('mongodb', { connectionString: '' })).toThrowError(ZodError)
  })
})

describe('parseMonitorConfig redis', () => {
  it('defaults query and timeout', () => {
    expect(parseMonitorConfig('redis', { connectionString: 'redis://127.0.0.1:1' })).toEqual({
      connectionString: 'redis://127.0.0.1:1',
      timeoutMs: 10_000,
      query: 'PING',
    })
  })

  it('keeps a custom query and rejects an empty one', () => {
    expect(
      parseMonitorConfig('redis', {
        connectionString: 'redis://127.0.0.1:1',
        query: 'GET queue:length',
      }).query,
    ).toBe('GET queue:length')
    expect(() =>
      parseMonitorConfig('redis', { connectionString: 'redis://127.0.0.1:1', query: '' }),
    ).toThrowError(ZodError)
  })
})

describe('parseMonitorConfig docker', () => {
  it('defaults expectedState and timeout for a unix socket', () => {
    expect(
      parseMonitorConfig('docker', {
        hostUri: 'unix:///var/run/docker.sock',
        containerNameOrId: 'web',
      }),
    ).toEqual({
      hostUri: 'unix:///var/run/docker.sock',
      containerNameOrId: 'web',
      expectedState: 'running',
      timeoutMs: 10_000,
    })
  })

  it('keeps a fully specified tcp config with TLS material and strips unknown keys', () => {
    expect(
      parseMonitorConfig('docker', {
        hostUri: 'tcp://docker.internal:2376',
        containerNameOrId: 'api-1',
        expectedState: 'exited',
        tlsCaPem: 'CA',
        tlsCertPem: 'CERT',
        tlsKeyPem: 'KEY',
        timeoutMs: 3000,
        bogus: true,
      }),
    ).toEqual({
      hostUri: 'tcp://docker.internal:2376',
      containerNameOrId: 'api-1',
      expectedState: 'exited',
      tlsCaPem: 'CA',
      tlsCertPem: 'CERT',
      tlsKeyPem: 'KEY',
      timeoutMs: 3000,
    })
  })

  it('rejects unsupported host URIs and empty fields', () => {
    const invalids: Array<[string, unknown]> = [
      ['http hostUri', { hostUri: 'http://127.0.0.1:2375', containerNameOrId: 'web' }],
      ['npipe hostUri', { hostUri: 'npipe:////./pipe/docker_engine', containerNameOrId: 'web' }],
      ['empty unix path', { hostUri: 'unix://', containerNameOrId: 'web' }],
      ['empty container', { hostUri: 'unix:///var/run/docker.sock', containerNameOrId: '' }],
    ]
    for (const [label, raw] of invalids) {
      expect(() => parseMonitorConfig('docker', raw), label).toThrowError(ZodError)
    }
  })
})
