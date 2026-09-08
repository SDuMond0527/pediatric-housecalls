import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/auth'

test.describe('Admin schedule page', () => {
  test('loads without a 500', async ({ page }) => {
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/appointments') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsAdmin(page)
    await page.goto('/admin/schedule')

    // "Add appointment" button is a unique, stable landmark that only renders
    // when the schedule page has actually mounted.
    await expect(page.getByRole('button', { name: /add appointment/i })).toBeVisible({ timeout: 15_000 })

    expect(apiFailures, `Server errors on /api/appointments: ${apiFailures.join(', ')}`).toEqual([])
  })
})
