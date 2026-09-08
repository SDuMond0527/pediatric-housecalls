import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/auth'

test.describe('Vaccines tab', () => {
  test('vaccines tab renders on first patient', async ({ page }) => {
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsAdmin(page)
    await page.goto('/patients')

    const firstPatientRow = page.getByRole("button").filter({ hasText: /\d{4}/ }).first()
    await expect(firstPatientRow).toBeVisible({ timeout: 15_000 })
    await firstPatientRow.click()
    await page.waitForURL(/\/(admin\/)?chart\//, { timeout: 10_000 })

    // Wait for chart to load, then click the Vaccines tab pill.
    await expect(page.getByRole('button', { name: /book appointment/i })).toBeVisible({ timeout: 10_000 })
    await page.getByText('Vaccines', { exact: false }).first().click()

    // Content either shows the vaccine table OR an empty state — page must
    // not crash. Wait briefly for the tab to render.
    await page.waitForTimeout(500)

    expect(apiFailures, `Server errors: ${apiFailures.join(', ')}`).toEqual([])
  })
})
