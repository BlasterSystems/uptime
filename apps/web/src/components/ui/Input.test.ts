import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import Input from './Input.vue'

describe('Input model typing', () => {
  it('keeps the emitted value a string for type="number" (regression: N.trim crash)', async () => {
    // Vue's v-model on a native number input applies looseToNumber; the form
    // state contract is `string`, so the component must normalize back.
    const wrapper = mount(Input, { props: { type: 'number', modelValue: '' } })
    await wrapper.find('input').setValue('1300')
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['1300'])

    await wrapper.find('input').setValue('')
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([''])
  })

  it('renders a numeric modelValue as its string form', () => {
    const wrapper = mount(Input, {
      props: { type: 'number', modelValue: 1300 as unknown as string },
    })
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('1300')
  })

  it('emits strings for plain text inputs', async () => {
    const wrapper = mount(Input, { props: { modelValue: '' } })
    await wrapper.find('input').setValue('Example')
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['Example'])
  })
})
