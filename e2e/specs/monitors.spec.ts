import { expect, test, type Page } from '@playwright/test'
import { login } from '../global-setup.js'

const NAME = `as267 prod e2e`

test.beforeEach(async ({ page }) => {
  await login(page)
})

async function openAddDialog(page: Page) {
  await page.getByRole('button', { name: 'Add monitor' }).click()
  return page.getByRole('dialog')
}

test.describe('monitors', () => {
  // Regression for the reported bug: typing a numeric interval stored a number
  // in string-typed form state and crashed the submit (`N.trim is not a
  // function`), silently swallowing the click.
  test('creates a monitor from the reported failing state (typed interval, retries 0)', async ({
    page,
  }) => {
    const dialog = await openAddDialog(page)
    await dialog.getByLabel('Name').fill(NAME)
    await dialog.getByLabel('URL').fill('https://example.com')
    await dialog.getByLabel('Keyword', { exact: true }).fill('Signed in')
    await dialog.getByLabel('Check interval').fill('1300')
    await dialog.getByLabel('Retries').fill('0')
    await dialog.locator('input[placeholder="production, external"]').fill('production')
    await dialog
      .getByRole('switch', { name: 'Show on the public status page' })
      .click()
    await dialog.getByRole('button', { name: 'Create monitor' }).click()

    // Success closes the dialog for non-push monitors and lists the monitor.
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('link', { name: NAME })).toBeVisible()

    // The monitor was flagged public: it appears on the public overview.
    await page.goto('/status')
    await expect(page.getByText(NAME)).toBeVisible()
  })

  test('keeps validation errors inline without sending the create request', async ({ page }) => {
    const dialog = await openAddDialog(page)
    await dialog.getByLabel('Check interval').fill('10')
    await dialog.getByRole('button', { name: 'Create monitor' }).click()

    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Enter a name.')).toBeVisible()
    await expect(dialog.getByText('Enter an interval of at least 20 s.')).toBeVisible()
  })

  test('edits a monitor and toasts success', async ({ page }) => {
    await page.getByRole('link', { name: NAME }).click()
    await page.getByRole('button', { name: 'Edit' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Name').fill(`${NAME} v2`)
    await dialog.getByRole('button', { name: 'Save changes' }).click()

    await expect(dialog).toBeHidden()
    await expect(page.getByText('Monitor updated')).toBeVisible()
    await expect(page.getByRole('heading', { name: `${NAME} v2` })).toBeVisible()
  })
})
