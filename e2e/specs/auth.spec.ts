import { expect, test } from '@playwright/test'
import { ADMIN, login } from '../global-setup.js'

test.describe('authentication', () => {
  test('redirects unauthenticated visits to the login page', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/login/)
  })

  test('signs in with valid credentials', async ({ page }) => {
    await login(page)
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  })

  test('rejects wrong credentials with a visible error', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill(ADMIN.email)
    await page.getByLabel('Password').fill('definitely not the password')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.locator('[role="alert"]')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })
})
