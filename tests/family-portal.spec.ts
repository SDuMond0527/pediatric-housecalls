import { test, expect } from '@playwright/test'
import { loginAsFamily } from './helpers/auth'

test.describe('Family portal', () => {
  test('dashboard loads after login', async ({ page }) => {
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsFamily(page)
    // Post-login landing is either the dashboard OR the mandatory
    // CompleteChildProfileGate when the test family fixture has any child
    // missing a required field (added 2026-09-11). Either is a valid landing
    // that proves the app is up and not 500ing.
    await expect(
      page.getByText(/Book a visit|Complete your child's profile/i).first()
    ).toBeVisible({ timeout: 15_000 })
    expect(apiFailures, `Server errors: ${apiFailures.join(', ')}`).toEqual([])
  })
})
