import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/auth'

test.describe('Reports page', () => {
  test('landing view renders without a React error / 500', async ({ page }) => {
    const apiFailures: string[] = []
    const consoleErrors: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/reports') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })
    page.on('pageerror', err => { consoleErrors.push(err.message) })

    await loginAsAdmin(page)
    await page.goto('/admin/reports')

    // The Payroll Report heading is unique to this page.
    await expect(page.getByRole('heading', { name: /payroll report/i })).toBeVisible({ timeout: 15_000 })

    expect(apiFailures, `Server errors on /api/reports: ${apiFailures.join(', ')}`).toEqual([])
    expect(consoleErrors, `Uncaught page errors: ${consoleErrors.join(' | ')}`).toEqual([])
  })
})
