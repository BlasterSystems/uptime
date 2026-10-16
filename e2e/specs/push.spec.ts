import { expect, test } from '@playwright/test'
import { login } from '../global-setup.js'

const NAME = 'push e2e'

test('creates a push monitor and accepts its heartbeat', async ({ page, request }) => {
  await login(page)
  await page.getByRole('button', { name: 'Add monitor' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add monitor' })
  await dialog.getByLabel('Name').fill(NAME)
  await dialog.getByLabel('Type').selectOption({ label: 'Push — wait for an incoming heartbeat' })
  await dialog.getByRole('button', { name: 'Create monitor' }).click()

  // Push monitors stay open on the "Monitor created" panel with the URL.
  const created = page.getByRole('dialog', { name: 'Monitor created' })
  await expect(created.getByText('Send a GET or POST request to this URL')).toBeVisible()
  const pushUrl = await created.locator('code.copy-value').textContent()
  expect(pushUrl).toMatch(/\/api\/v1\/push\//)

  const beat = await request.post(pushUrl!)
  expect(beat.status()).toBe(200)

  await created.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('link', { name: NAME }).click()
  await expect(page.getByRole('heading', { name: NAME })).toBeVisible()

  // The heartbeat lands on the dashboard card as an Up badge.
  await page.goto('/')
  const card = page.locator('article.card', { hasText: NAME })
  await expect(card.getByText('Up', { exact: true })).toBeVisible()
})
