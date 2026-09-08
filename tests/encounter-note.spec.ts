import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/auth'

test.describe('Encounter note modal', () => {
  test('opens from patient chart without a crash', async ({ page }) => {
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/encounter-notes') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsAdmin(page)
    await page.goto('/patients')

    const firstPatientRow = page.getByRole("button").filter({ hasText: /\d{4}/ }).first()
    await expect(firstPatientRow).toBeVisible({ timeout: 15_000 })
    await firstPatientRow.click()
    await page.waitForURL(/\/(admin\/)?chart\//, { timeout: 10_000 })

    await expect(page.getByRole('button', { name: /book appointment/i })).toBeVisible({ timeout: 10_000 })

    // Encounters tab.
    await page.getByText('Encounters', { exact: false }).first().click()
    await page.waitForTimeout(1000)

    // If there are no encounters for this patient, skip. Otherwise try to open.
    const openBtn = page.getByRole('button', { name: /open note|edit note/i })
    if (await openBtn.count() === 0) {
      test.skip(true, 'No encounters for first patient — nothing to open')
    }

    await openBtn.first().click()
    // Modal should render an "Encounter Note" heading.
    await expect(page.getByRole('heading', { name: /encounter note/i })).toBeVisible({ timeout: 10_000 })

    expect(apiFailures, `Server errors: ${apiFailures.join(', ')}`).toEqual([])
  })
})
