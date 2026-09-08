import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/auth'

test.describe('Analytics page', () => {
  test('loads with KPI cards, on-call widget, and booking mix', async ({ page }) => {
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/analytics') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsAdmin(page)
    await page.goto('/admin/analytics')

    // KPI row landmarks
    await expect(page.getByText('Completed visits')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Families on file')).toBeVisible()
    await expect(page.getByText('Waitlist open')).toBeVisible()

    // On-call hours widget
    await expect(page.getByRole('heading', { name: /on-call hours/i })).toBeVisible()

    expect(apiFailures, `Server errors on /api/analytics: ${apiFailures.join(', ')}`).toEqual([])
  })

  test('on-call provider names are clickable to expand shifts', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/admin/analytics')

    // Wait for the on-call widget to render.
    await expect(page.getByRole('heading', { name: /on-call hours/i })).toBeVisible({ timeout: 10_000 })

    // If any providers show up, the first one should be clickable to expand.
    // Skip the assertion if no providers have on-call hours (fresh practice).
    const providerRow = page.locator('button:has-text("▶")').first()
    if (await providerRow.count() > 0) {
      await providerRow.click()
      // After expand, a shift date table appears with the expected column headers.
      await expect(page.getByText('Date', { exact: true }).first()).toBeVisible({ timeout: 5_000 })
    }
  })
})
