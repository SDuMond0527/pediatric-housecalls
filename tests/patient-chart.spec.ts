import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/auth'

test.describe('Patient chart', () => {
  test('opens a patient chart without a 500', async ({ page }) => {
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsAdmin(page)
    await page.goto('/patients')

    // Patients page renders each patient as a <button> with DOB text (unique
    // to patient rows). Click the first one.
    const firstPatientRow = page.getByRole("button").filter({ hasText: /\d{4}/ }).first()
    await expect(firstPatientRow).toBeVisible({ timeout: 15_000 })
    await firstPatientRow.click()

    // Admins land on /admin/chart/<id>, non-admin providers on /chart/<id>.
    await page.waitForURL(/\/(admin\/)?chart\//, { timeout: 10_000 })

    // "Book appointment" and "Add sibling" buttons are landmarks at the top
    // of every patient chart.
    await expect(page.getByRole('button', { name: /book appointment/i })).toBeVisible({ timeout: 10_000 })

    expect(apiFailures, `Server errors: ${apiFailures.join(', ')}`).toEqual([])
  })
})
