import { expect, test } from '@playwright/test'
import { login } from '../global-setup.js'

const NAME = 'refused e2e'

test('opens an incident when a monitor fails past its retries', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'Add monitor' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add monitor' })
  await dialog.getByLabel('Name').fill(NAME)
  // Only http (and docker) monitors are probe-scheduled, so use an http check
  // against a refused port; retries 0 opens the incident on the first failure.
  await dialog.getByLabel('URL').fill('http://127.0.0.1:1')
  await dialog.getByLabel('Retries').fill('0')
  await dialog.getByRole('button', { name: 'Create monitor' }).click()

  await expect(dialog).toBeHidden()

  await page.getByRole('link', { name: 'Incidents' }).click()
  const row = page.locator('span.cell-strong', { hasText: NAME })
  await expect(row).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText('Ongoing')).toBeVisible()
})
