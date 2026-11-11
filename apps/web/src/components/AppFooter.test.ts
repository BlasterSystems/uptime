import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AppFooter from './AppFooter.vue'

const env = import.meta.env as { VITE_DEPLOY_TAG?: string }

afterEach(() => {
  delete env.VITE_DEPLOY_TAG
})

describe('AppFooter', () => {
  it('renders the injected deployment tag', () => {
    env.VITE_DEPLOY_TAG = 'dev-20261111-1034'
    const wrapper = mount(AppFooter)
    expect(wrapper.find('footer').text()).toBe('dev-20261111-1034')
    expect(wrapper.find('footer').attributes('title')).toBe('Deployment dev-20261111-1034')
  })

  it('renders the source stamp when no tag was injected', () => {
    const wrapper = mount(AppFooter)
    expect(wrapper.text()).toBe('source')
  })
})
