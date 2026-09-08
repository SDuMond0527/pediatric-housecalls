import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/auth'

test.describe('Provider Today view', () => {
  test('loads without a 500, shows the today UI', async ({ page }) => {
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/appointments') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsAdmin(page)
    await page.goto('/today')

    // "Good <time>, <name>!" greeting is the stable landmark on Today.
    await expect(page.getByText(/good (morning|afternoon|evening)/i)).toBeVisible({ timeout: 10_000 })

    // Stat cards for appointment counts always render, even if today has zero
    // appointments.
    await expect(page.getByText('Total today')).toBeVisible()
    await expect(page.getByText('Remaining')).toBeVisible()

    expect(apiFailures, `Server errors on /api/appointments: ${apiFailures.join(', ')}`).toEqual([])
  })

  test('date arrows navigate to next/previous day without crashing', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/today')

    await expect(page.getByText('Today', { exact: false })).toBeVisible({ timeout: 10_000 })

    // Previous day arrow — should navigate and the header should update.
    const prevBtn = page.locator('button').filter({ has: page.locator('svg') }).first()
    await prevBtn.click()
    // Wait for the page to settle (the greeting should still be there).
    await expect(page.getByText(/good (morning|afternoon|evening)/i)).toBeVisible()
  })
})
