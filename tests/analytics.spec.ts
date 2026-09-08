import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/auth'

test.describe('Analytics page', () => {
  test('loads without a 500', async ({ page }) => {
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/analytics') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsAdmin(page)
    await page.goto('/admin/analytics')

    // "Practice-wide · All time" is subtext unique to the Analytics header.
    await expect(page.getByText('Practice-wide', { exact: false })).toBeVisible({ timeout: 15_000 })

    // On-call widget's heading is unique on this page.
    await expect(page.getByRole('heading', { name: /on-call hours/i })).toBeVisible({ timeout: 15_000 })

    expect(apiFailures, `Server errors on /api/analytics: ${apiFailures.join(', ')}`).toEqual([])
  })
})
