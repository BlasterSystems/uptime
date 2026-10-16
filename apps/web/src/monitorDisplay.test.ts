import { describe, expect, it } from 'vitest'
import type { Monitor } from './api.js'
import { maskConnectionString, monitorTarget } from './monitorDisplay.js'

function monitor(type: Monitor['type'], config: Record<string, unknown>): Monitor {
  return { type, config } as unknown as Monitor
}

describe('maskConnectionString', () => {
  it('masks URL userinfo', () => {
    expect(maskConnectionString('postgres://user:secret@db.example.com:5432/svc')).toBe(
      'postgres://***@db.example.com:5432/svc',
    )
  })

  it('masks ADO-style password segments case-insensitively', () => {
    expect(maskConnectionString('Server=db;Password=hunter2;TrustServerCertificate=true')).toBe(
      'Server=db;Password=***;TrustServerCertificate=true',
    )
    expect(maskConnectionString('server=db;pwd=hunter2')).toBe('server=db;pwd=***')
  })

  it('leaves credential-free strings alone', () => {
    expect(maskConnectionString('redis://cache.internal:6379')).toBe(
      'redis://cache.internal:6379',
    )
  })
})

describe('monitorTarget', () => {
  it('summarizes each monitor type', () => {
    expect(monitorTarget(monitor('http', { url: 'https://example.com' }))).toBe(
      'https://example.com',
    )
    expect(monitorTarget(monitor('push', {}))).toBe('Waiting for incoming heartbeats')
    expect(monitorTarget(monitor('tcp', { host: 'db.local', port: 5432 }))).toBe('db.local:5432')
    expect(monitorTarget(monitor('dns', { host: 'example.com', recordType: 'MX' }))).toBe(
      'MX example.com',
    )
    expect(monitorTarget(monitor('icmp', { host: 'router.lan' }))).toBe('router.lan')
    expect(
      monitorTarget(monitor('postgres', { connectionString: 'postgres://u:p@db/svc' })),
    ).toBe('postgres://***@db/svc')
    expect(monitorTarget(monitor('docker', { containerNameOrId: 'api-1' }))).toBe('api-1')
    expect(monitorTarget(monitor('group', { memberIds: [1, 2] }))).toBe('2 members')
    expect(monitorTarget(monitor('group', { memberIds: [1] }))).toBe('1 member')
  })
})
