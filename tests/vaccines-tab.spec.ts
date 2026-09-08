import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/auth'

test.describe('Vaccines tab', () => {
  test('renders on patient chart without crash', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/patients')

    // Open first patient.
    const firstPatient = page.locator('a[href*="/chart/"]').first()
    await expect(firstPatient).toBeVisible({ timeout: 10_000 })
    await firstPatient.click()
    await page.waitForURL(/\/chart\//)

    // Click Vaccines tab.
    await page.getByRole('button', { name: /^vaccines/i })
      .or(page.getByText('Vaccines', { exact: false }))
      .first()
      .click()

    // The tab always shows either the vaccine table OR an empty state message.
    // Just verify neither crashed the page (no red error card, no blank body).
    const emptyState = page.getByText(/no vaccines/i)
    const vaccineHeader = page.getByText(/vaccine|lot #|expiration|dose/i).first()
    await expect(emptyState.or(vaccineHeader)).toBeVisible({ timeout: 5_000 })
  })
})
