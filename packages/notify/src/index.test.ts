import { describe, expect, it } from 'vitest'
import { Notifier } from './index.js'
import type { ChannelLike, NotifierOptions, SendFn } from './index.js'
import type { ChannelType, NotifyPayload } from './types.js'

const payload: NotifyPayload = {
  title: 'Example is down',
  body: 'Connection refused',
  monitorName: 'Example',
  status: 'down',
  latencyMs: null,
  downtimeMs: 60_000,
  tags: [],
}

function makeChannel(id: number, overrides: Partial<ChannelLike> = {}): ChannelLike {
  return { id, type: 'webhook', name: `channel-${id}`, config: { id }, active: true, ...overrides }
}

function makeOptions(overrides: Partial<NotifierOptions> = {}): NotifierOptions {
  return {
    channels: () => [],
    monitorChannelIds: () => [],
    defaultChannelIds: () => [],
    ...overrides,
  }
}

interface SentCall {
  type: ChannelType
  config: unknown
  payload: NotifyPayload
}

function makeRecorder(): { calls: SentCall[]; send: SendFn } {
  const calls: SentCall[] = []
  return {
    calls,
    send: async (type, config, sentPayload) => {
      calls.push({ type, config, payload: sentPayload })
    },
  }
}

describe('Notifier.notifyMonitor', () => {
  it("sends to the monitor's routed channels", async () => {
    const { calls, send } = makeRecorder()
    const channels = [makeChannel(1), makeChannel(2, { type: 'telegram' })]
    const notifier = new Notifier(
      makeOptions({
        channels: () => channels,
        monitorChannelIds: (monitorId) => (monitorId === 7 ? [2] : []),
        defaultChannelIds: () => [1],
        send,
      }),
    )
    await expect(notifier.notifyMonitor(7, payload)).resolves.toEqual([])
    expect(calls).toEqual([{ type: 'telegram', config: { id: 2 }, payload }])
  })

  it('falls back to the default channels when the monitor has no routing', async () => {
    const { calls, send } = makeRecorder()
    const notifier = new Notifier(
      makeOptions({
        channels: () => [makeChannel(1), makeChannel(2)],
        monitorChannelIds: () => [],
        defaultChannelIds: () => [1, 2],
        send,
      }),
    )
    await notifier.notifyMonitor(7, payload)
    expect(calls).toEqual([
      { type: 'webhook', config: { id: 1 }, payload },
      { type: 'webhook', config: { id: 2 }, payload },
    ])
  })

  it('skips inactive channels', async () => {
    const { calls, send } = makeRecorder()
    const notifier = new Notifier(
      makeOptions({
        channels: () => [makeChannel(2, { active: false }), makeChannel(3)],
        monitorChannelIds: () => [2, 3],
        send,
      }),
    )
    await notifier.notifyMonitor(7, payload)
    expect(calls).toEqual([{ type: 'webhook', config: { id: 3 }, payload }])
  })

  it('does not fall back when the routed channels are all inactive', async () => {
    const { calls, send } = makeRecorder()
    const notifier = new Notifier(
      makeOptions({
        channels: () => [makeChannel(9, { active: false }), makeChannel(1)],
        monitorChannelIds: () => [9],
        defaultChannelIds: () => [1],
        send,
      }),
    )
    await expect(notifier.notifyMonitor(7, payload)).resolves.toEqual([])
    expect(calls).toEqual([])
  })

  it('is a no-op when no channels are configured', async () => {
    const { calls, send } = makeRecorder()
    const notifier = new Notifier(makeOptions({ send }))
    await expect(notifier.notifyMonitor(7, payload)).resolves.toEqual([])
    expect(calls).toEqual([])
  })

  it('dedupes repeated routed channel ids', async () => {
    const { calls, send } = makeRecorder()
    const notifier = new Notifier(
      makeOptions({
        channels: () => [makeChannel(1)],
        monitorChannelIds: () => [1, 1],
        send,
      }),
    )
    await notifier.notifyMonitor(7, payload)
    expect(calls).toHaveLength(1)
  })

  it('isolates failures and reports one error per failed channel', async () => {
    const attempted: ChannelType[] = []
    const send: SendFn = async (type) => {
      attempted.push(type)
      if (type === 'telegram') throw new Error('telegram exploded')
    }
    const notifier = new Notifier(
      makeOptions({
        channels: () => [makeChannel(1, { type: 'telegram' }), makeChannel(2, { type: 'discord' })],
        monitorChannelIds: () => [1, 2],
        send,
      }),
    )
    await expect(notifier.notifyMonitor(7, payload)).resolves.toEqual([
      { channelId: '1', error: 'telegram exploded' },
    ])
    expect(attempted).toEqual(['telegram', 'discord'])
  })

  it('stringifies non-Error rejections', async () => {
    const notifier = new Notifier(
      makeOptions({
        channels: () => [makeChannel(1)],
        monitorChannelIds: () => [1],
        send: () => Promise.reject('plain failure'),
      }),
    )
    await expect(notifier.notifyMonitor(7, payload)).resolves.toEqual([
      { channelId: '1', error: 'plain failure' },
    ])
  })

  it('runs sends concurrently', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const ends: string[] = []
    const send: SendFn = async (type) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      // Yields once: a sequential implementation finishes send #1 before #2 starts.
      await Promise.resolve()
      inFlight -= 1
      ends.push(`end ${type}`)
    }
    const notifier = new Notifier(
      makeOptions({
        channels: () => [makeChannel(1, { type: 'telegram' }), makeChannel(2, { type: 'discord' })],
        monitorChannelIds: () => [1, 2],
        send,
      }),
    )
    await notifier.notifyMonitor(7, payload)
    expect(maxInFlight).toBe(2)
    expect(ends).toEqual(['end telegram', 'end discord'])
  })
})

describe('Notifier.testChannel', () => {
  it('sends a test payload mentioning the channel name', async () => {
    const { calls, send } = makeRecorder()
    const notifier = new Notifier(makeOptions({ send }))
    await notifier.testChannel(
      makeChannel(5, { type: 'ntfy', name: 'Ops alerts', config: { topic: 'ops' } }),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.type).toBe('ntfy')
    expect(calls[0]?.config).toEqual({ topic: 'ops' })
    expect(calls[0]?.payload).toMatchObject({
      title: 'Test notification',
      monitorName: 'Test',
      status: 'up',
      latencyMs: null,
      downtimeMs: null,
      tags: [],
    })
    expect(calls[0]?.payload.body).toContain('Ops alerts')
  })

  it('sends to inactive channels and rejects on failure', async () => {
    const { calls, send } = makeRecorder()
    const notifier = new Notifier(makeOptions({ send }))
    await notifier.testChannel(makeChannel(5, { active: false }))
    expect(calls).toHaveLength(1)

    const failing = new Notifier(
      makeOptions({
        send: async () => {
          throw new Error('channel rejected the test')
        },
      }),
    )
    await expect(failing.testChannel(makeChannel(5))).rejects.toThrow('channel rejected the test')
  })
})
