import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/auth'

test.describe('Provider Today view', () => {
  test('loads without a 500', async ({ page }) => {
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/appointments') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsAdmin(page)
    await page.goto('/today')

    // "Total today" is a stat card label that's unique to Today view.
    await expect(page.getByText('Total today', { exact: true })).toBeVisible({ timeout: 15_000 })

    expect(apiFailures, `Server errors on /api/appointments: ${apiFailures.join(', ')}`).toEqual([])
  })
})
