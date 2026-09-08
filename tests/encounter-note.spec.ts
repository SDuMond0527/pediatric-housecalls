import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/auth'

test.describe('Encounter note modal', () => {
  test('opens from patient chart and shows Procedures & Fees / Diagnoses sections', async ({ page }) => {
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/encounter-notes') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsAdmin(page)
    await page.goto('/patients')

    // Open the first patient in the list.
    const firstPatient = page.locator('a[href*="/chart/"]').first()
    await expect(firstPatient).toBeVisible({ timeout: 10_000 })
    await firstPatient.click()
    await page.waitForURL(/\/chart\//)

    // Go to Encounters tab.
    await page.getByRole('button', { name: /^encounters$/i })
      .or(page.getByText('Encounters', { exact: true }))
      .first()
      .click()

    // Click the first encounter to expand it (if any encounters exist).
    const firstEncounter = page.locator('button:has-text("In-home")').or(page.locator('button:has-text("visit")')).first()
    if (await firstEncounter.count() === 0) {
      test.skip(true, 'No encounters on the first patient — need a patient with an encounter for this test')
    }

    await firstEncounter.click()

    // Click "Open note" button in the expanded encounter card.
    const openBtn = page.getByRole('button', { name: /open note|edit note/i }).first()
    await expect(openBtn).toBeVisible({ timeout: 5_000 })
    await openBtn.click()

    // Modal should show the "Encounter Note" heading.
    await expect(page.getByRole('heading', { name: /encounter note/i })).toBeVisible({ timeout: 10_000 })

    // Either a Procedures & Fees section OR an Assessment/Diagnoses section
    // should be present. (Not every note has both.)
    const procHeader = page.getByText(/procedures.*fees/i)
    const dxHeader = page.getByText(/assessment.*diagnoses|icd code/i)
    await expect(procHeader.or(dxHeader).first()).toBeVisible()

    expect(apiFailures, `Server errors: ${apiFailures.join(', ')}`).toEqual([])

    // Close the modal without saving anything.
    await page.getByRole('button', { name: /close|×/i }).last().click().catch(() => {})
  })
})
