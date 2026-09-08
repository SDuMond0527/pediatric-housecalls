import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/auth'

test.describe('Waitlist and broadcasts pages', () => {
  test('waitlist page loads', async ({ page }) => {
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/waitlist') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsAdmin(page)
    await page.goto('/waitlist')

    // Header always renders, even with an empty waitlist.
    await expect(page.getByText(/waitlist/i).first()).toBeVisible({ timeout: 10_000 })

    expect(apiFailures, `Server errors on /api/waitlist: ${apiFailures.join(', ')}`).toEqual([])
  })

  test('broadcasts page loads', async ({ page }) => {
    const apiFailures: string[] = []
    page.on('response', res => {
      if (res.url().includes('/api/broadcasts') && res.status() >= 500) {
        apiFailures.push(`${res.status()} on ${res.url()}`)
      }
    })

    await loginAsAdmin(page)
    await page.goto('/broadcasts')

    await expect(page.getByText(/broadcast/i).first()).toBeVisible({ timeout: 10_000 })

    expect(apiFailures, `Server errors on /api/broadcasts: ${apiFailures.join(', ')}`).toEqual([])
  })
})
