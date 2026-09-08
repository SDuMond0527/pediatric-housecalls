import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/auth'

test.describe('Waitlist and broadcasts pages', () => {
  test('waitlist page loads without a 500', async ({ page }) => {
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/waitlist') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsAdmin(page)
    // Admins land on /admin/waitlist (AdminWaitlist); non-admin providers land
    // on /waitlist (Waitlist). Test as admin.
    await page.goto('/admin/waitlist')

    // Heading + subtext are stable landmarks on either page variant.
    await expect(page.getByText(/waitlist/i).first()).toBeVisible({ timeout: 15_000 })

    expect(apiFailures, `Server errors on /api/waitlist: ${apiFailures.join(', ')}`).toEqual([])
  })

  test('broadcasts page loads without a 500', async ({ page }) => {
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/broadcasts') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsAdmin(page)
    await page.goto('/admin/broadcasts')

    await expect(page.getByText(/broadcasts/i).first()).toBeVisible({ timeout: 15_000 })

    expect(apiFailures, `Server errors on /api/broadcasts: ${apiFailures.join(', ')}`).toEqual([])
  })
})
