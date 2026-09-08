import { test, expect } from '@playwright/test'
import { loginAsFamily } from './helpers/auth'

test.describe('Family portal', () => {
  test('dashboard loads after login', async ({ page }) => {
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsFamily(page)
    // loginAsFamily already waits for /family/dashboard etc.

    // Common landmarks that always appear on the family portal.
    const home = page.getByRole('link', { name: /home/i }).or(page.getByText(/upcoming/i))
    await expect(home.first()).toBeVisible({ timeout: 10_000 })

    expect(apiFailures, `Server errors: ${apiFailures.join(', ')}`).toEqual([])
  })

  test('vaccines page loads', async ({ page }) => {
    await loginAsFamily(page)
    await page.goto('/family/vaccines')
    // Either shows a vaccine table or an empty state — both are OK.
    await expect(page.getByText(/vaccine/i).first()).toBeVisible({ timeout: 10_000 })
  })

  test('visit history page loads', async ({ page }) => {
    await loginAsFamily(page)
    await page.goto('/family/visits')
    await expect(page.getByText(/visit/i).first()).toBeVisible({ timeout: 10_000 })
  })
})
