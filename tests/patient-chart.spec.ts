import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/auth'

test.describe('Patient chart', () => {
  test('opens a patient and every tab renders without a 500', async ({ page }) => {
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsAdmin(page)
    await page.goto('/patients')

    // Wait for the patient list to render, then click the first patient row.
    const firstPatientRow = page.locator('a[href*="/chart/"]').first()
    await expect(firstPatientRow).toBeVisible({ timeout: 10_000 })
    await firstPatientRow.click()

    // Chart URL like /chart/<uuid>
    await page.waitForURL(/\/chart\//, { timeout: 10_000 })

    // Cycle through every tab. Each is a stable role='button' or role='tab' —
    // the wording in the app is a rounded pill, so grab by text match.
    const tabs = ['Overview', 'Appointments', 'Encounters', 'Vaccines', 'Prescribe', 'Labs', 'Growth Chart']
    for (const tabName of tabs) {
      const tab = page.getByRole('button', { name: new RegExp(`^${tabName}$`, 'i') })
        .or(page.getByText(tabName, { exact: true }))
        .first()
      await tab.click()
      // Wait briefly for the tab's content region to settle.
      await page.waitForTimeout(300)
    }

    expect(apiFailures, `Server errors during tab cycle: ${apiFailures.join(', ')}`).toEqual([])
  })
})
