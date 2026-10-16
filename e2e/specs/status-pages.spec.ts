import { expect, test } from '@playwright/test'
import { login } from '../global-setup.js'

const SLUG = 'e2e-status'
const TITLE = 'E2E Status'

test('creates a published status page and renders it publicly', async ({ page }) => {
  await login(page)
  await page.goto('/settings')
  await page.getByRole('tab', { name: 'Status pages' }).click()
  await page.getByRole('button', { name: 'Create page' }).click()

  const dialog = page.getByRole('dialog', { name: 'Create status page' })
  await dialog.getByLabel('Slug').fill(SLUG)
  await dialog.getByLabel('Title').fill(TITLE)
  const published = dialog.getByRole('switch', { name: 'Published' })
  if ((await published.getAttribute('aria-checked')) === 'false') await published.click()
  await dialog.getByRole('button', { name: 'Create page' }).click()

  await expect(dialog).toBeHidden()
  const row = page.getByRole('row', { name: SLUG })
  await expect(row).toBeVisible()
  await expect(row.getByRole('link', { name: 'Open' })).toHaveAttribute(
    'href',
    `/status/${SLUG}`,
  )

  await page.goto(`/status/${SLUG}`)
  await expect(page.getByText(TITLE)).toBeVisible()
})
