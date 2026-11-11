import { afterEach, describe, expect, it } from 'vitest'
import { deployTag } from './buildInfo.js'

const env = import.meta.env as { VITE_DEPLOY_TAG?: string }

afterEach(() => {
  delete env.VITE_DEPLOY_TAG
})

describe('deployTag', () => {
  it('prefers the injected deployment tag', () => {
    env.VITE_DEPLOY_TAG = 'dev-20261111-1034'
    expect(deployTag()).toBe('dev-20261111-1034')
  })

  it('falls back to the source stamp when no tag was injected', () => {
    expect(deployTag()).toBe('source')
  })

  it('treats an empty injection as unset', () => {
    env.VITE_DEPLOY_TAG = ''
    expect(deployTag()).toBe('source')
  })
})
