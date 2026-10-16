import { expect, test } from '@playwright/test'
import { login } from '../global-setup.js'

const NAME = 'E2E hook'

test('creates a webhook notification channel', async ({ page }) => {
  await login(page)
  await page.goto('/notifications')
  await page.getByRole('button', { name: 'Add channel' }).first().click()

  const dialog = page.getByRole('dialog', { name: 'Add notification channel' })
  await dialog.getByLabel('Name').fill(NAME)
  await dialog.getByLabel('Type').selectOption({ label: 'Webhook' })
  await dialog.getByLabel('URL').fill('https://hooks.example.com/e2e')
  await dialog.getByRole('button', { name: 'Create channel' }).click()

  await expect(dialog).toBeHidden()
  await expect(page.getByText(NAME, { exact: true })).toBeVisible()
})
