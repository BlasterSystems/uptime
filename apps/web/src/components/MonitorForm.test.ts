import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import type * as ApiModule from '../api.js'

vi.mock('../api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    createMonitor: vi.fn(),
    updateMonitor: vi.fn(),
    fetchTags: vi.fn(async () => []),
    fetchChannels: vi.fn(async () => []),
    fetchDockerHosts: vi.fn(async () => []),
    fetchMonitors: vi.fn(async () => []),
  }
})

import { ApiError, createMonitor, updateMonitor, type Monitor } from '../api.js'
import MonitorForm from './MonitorForm.vue'
import { useToast } from './ui/toast.js'

vi.mocked(createMonitor).mockResolvedValue({
  id: 1,
  type: 'http',
  name: 'acme prod',
  intervalS: 1300,
  retries: 0,
  active: true,
  config: { url: 'https://example.com' },
} as unknown as Monitor)
vi.mocked(updateMonitor).mockResolvedValue({
  id: 7,
  type: 'http',
  name: 'Renamed',
  intervalS: 60,
  retries: 0,
  active: true,
  config: { url: 'https://example.com' },
} as unknown as Monitor)

const ModalStub = { template: '<div><slot /><slot name="footer" /></div>' }

function mountForm(props: { open: boolean; monitor?: Monitor | null } = { open: false }) {
  return mount(MonitorForm, {
    props,
    global: { stubs: { Modal: ModalStub } },
  })
}

/** Opens the dialog the way the host views do (open flips false -> true). */
async function openForm(props: { monitor?: Monitor | null } = {}) {
  const wrapper = mountForm({ open: false, ...props })
  await wrapper.setProps({ open: true })
  await flushPromises()
  return wrapper
}

async function controlByLabel(wrapper: VueWrapper, label: string) {
  const normalized = label.toLowerCase()
  const labelEl = wrapper
    .findAll('label')
    .find((l) => l.text().replace(/\*/g, '').trim().toLowerCase() === normalized)
  if (!labelEl) throw new Error(`label not found: ${label}`)
  const id = labelEl.attributes('for')
  const control = wrapper
    .findAll('input, textarea, select')
    .find((el) => el.attributes('id') === id)
  if (!control) throw new Error(`control not found for label: ${label}`)
  return control
}

async function clickButton(wrapper: VueWrapper, text: string) {
  const button = wrapper.findAll('button').find((b) => b.text().includes(text))
  if (!button) throw new Error(`button not found: ${text}`)
  await button.trigger('click')
  await flushPromises()
}

function clearToasts() {
  const api = useToast()
  for (const toast of api.toasts.value) api.dismiss(toast.id)
}

const EDITING_MONITOR: Monitor = {
  id: 7,
  type: 'http',
  name: 'Old name',
  intervalS: 60,
  retries: 1,
  active: true,
  isPublic: false,
  tags: [],
  channelIds: [],
  config: { url: 'https://example.com', method: 'GET', timeoutMs: 10000 },
} as unknown as Monitor

beforeEach(() => {
  clearToasts()
  vi.mocked(createMonitor).mockClear()
  vi.mocked(updateMonitor).mockClear()
})

describe('MonitorForm create', () => {
  it('creates a monitor from the reported failing state (interval typed, retries 0)', async () => {
    const wrapper = await openForm()

    await (await controlByLabel(wrapper, 'Name')).setValue('acme prod')
    await (await controlByLabel(wrapper, 'URL')).setValue('https://example.com')
    await (await controlByLabel(wrapper, 'Headers')).setValue('Authorization: Bearer token')
    await (await controlByLabel(wrapper, 'Keyword')).setValue('Signed in')
    await (await controlByLabel(wrapper, 'Check interval')).setValue('1300')
    await (await controlByLabel(wrapper, 'Retries')).setValue('0')
    // The tags field has no label; it is announced by its placeholder.
    await wrapper.find('input[placeholder="production, external"]').setValue('production')
    const visLabel = wrapper
      .findAll('label')
      .find((l) => l.text().includes('Show on the public status page'))
    if (!visLabel) throw new Error('visibility label not found')
    await wrapper.find(`[aria-labelledby="${visLabel.attributes('id')}"]`).trigger('click')

    await clickButton(wrapper, 'Create monitor')

    expect(createMonitor).toHaveBeenCalledTimes(1)
    expect(createMonitor).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'acme prod',
        type: 'http',
        intervalS: 1300,
        retries: 0,
        isPublic: true,
        config: expect.objectContaining({
          url: 'https://example.com',
          method: 'GET',
          headers: { Authorization: 'Bearer token' },
          keyword: { value: 'Signed in' },
        }),
      }),
    )
    expect(wrapper.emitted('created')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('surfaces server validation errors inline and as a toast', async () => {
    vi.mocked(createMonitor).mockRejectedValueOnce(
      new ApiError(400, 'retries must be an integer in [0, 100]'),
    )
    const wrapper = await openForm()

    await (await controlByLabel(wrapper, 'Name')).setValue('Broken')
    await (await controlByLabel(wrapper, 'URL')).setValue('https://example.com')
    await clickButton(wrapper, 'Create monitor')

    const alerts = wrapper.findAll('[role="alert"]').map((el) => el.text())
    expect(alerts.some((text) => text.includes('retries must be an integer in [0, 100]'))).toBe(
      true,
    )
    const toasts = useToast().toasts.value
    expect(toasts.some((t) => t.type === 'error' && t.title === 'Could not create the monitor.')).toBe(true)
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('shows validation errors without calling the API', async () => {
    const wrapper = await openForm()

    await (await controlByLabel(wrapper, 'Check interval')).setValue('10')
    await clickButton(wrapper, 'Create monitor')

    expect(createMonitor).not.toHaveBeenCalled()
    const alerts = wrapper.findAll('[role="alert"]').map((el) => el.text())
    expect(alerts.some((text) => text.includes('Enter a name.'))).toBe(true)
    expect(alerts.some((text) => text.includes('Enter an interval of at least 20 s.'))).toBe(true)
  })
})

describe('MonitorForm update', () => {
  it('saves edits, toasts success and closes', async () => {
    const wrapper = await openForm({ monitor: EDITING_MONITOR })

    await (await controlByLabel(wrapper, 'Name')).setValue('Renamed')
    await (await controlByLabel(wrapper, 'Retries')).setValue('0')
    await clickButton(wrapper, 'Save changes')

    expect(updateMonitor).toHaveBeenCalledTimes(1)
    expect(updateMonitor).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ name: 'Renamed', retries: 0 }),
    )
    expect(wrapper.emitted('saved')).toHaveLength(1)
    const toasts = useToast().toasts.value
    expect(toasts.some((t) => t.type === 'success' && t.title === 'Monitor updated')).toBe(true)
  })
})
