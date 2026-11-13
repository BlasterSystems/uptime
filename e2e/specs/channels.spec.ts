import { expect, test } from '@playwright/test'
import { login } from '../global-setup.js'

const NAME = 'E2E Resend'

test('creates a Resend notification channel', async ({ page }) => {
  await login(page)
  await page.goto('/notifications')
  await page.getByRole('button', { name: 'Add channel' }).first().click()

  const dialog = page.getByRole('dialog', { name: 'Add notification channel' })
  await dialog.getByLabel('Name').fill(NAME)
  await dialog.getByLabel('Type').selectOption({ label: 'Email (Resend)' })
  await dialog.getByLabel('API key').fill('re_e2e_placeholder')
  await dialog.getByLabel('From address').fill('uptime@example.com')
  await dialog.getByLabel('To address').fill('oncall@example.com')
  await dialog.getByRole('button', { name: 'Create channel' }).click()

  await expect(dialog).toBeHidden()
  await expect(page.getByText(NAME, { exact: true })).toBeVisible()
})
