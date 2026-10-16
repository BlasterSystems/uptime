import { BASE_URL } from './playwright.config.js'
import type { Page } from '@playwright/test'

export const ADMIN = {
  email: 'admin@e2e.example.com',
  password: 'correct horse battery',
}

/** Seed the admin account; 409 means a previous run already created it. */
export async function globalSetup(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  })
  if (res.status !== 200 && res.status !== 409) {
    throw new Error(`admin setup failed: ${res.status} ${await res.text()}`)
  }
}

/** Signs in through the real login form. */
export async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Email').fill(ADMIN.email)
  await page.getByLabel('Password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(`${BASE_URL}/`)
}

export { BASE_URL }
export default globalSetup
