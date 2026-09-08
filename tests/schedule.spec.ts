import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/auth'

test.describe('Admin schedule page', () => {
  test('loads without a 500, shows the schedule UI', async ({ page }) => {
    // Track any /api/appointments responses so we can assert none returned 500.
    // This is exactly what would have caught this morning's outage.
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/appointments') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsAdmin(page)
    await page.goto('/admin/schedule')

    // The schedule header should be visible on any successful load.
    await expect(page.getByText('Schedule', { exact: false })).toBeVisible({ timeout: 10_000 })

    // The "Add appointment" button is a stable landmark that only appears when
    // the page actually rendered (not just spinning on a fetch).
    await expect(page.getByRole('button', { name: /add appointment/i })).toBeVisible()

    // Fail loudly if any /api/appointments call errored during the load.
    expect(apiFailures, `Server errors on /api/appointments: ${apiFailures.join(', ')}`).toEqual([])
  })

  test('date picker is present and defaults to today', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/admin/schedule')

    const dateInput = page.locator('input[type="date"]').first()
    await expect(dateInput).toBeVisible({ timeout: 10_000 })

    const today = new Date().toISOString().slice(0, 10)
    await expect(dateInput).toHaveValue(today)
  })
})
