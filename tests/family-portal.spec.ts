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
    // loginAsFamily waits for /family/... URL. Landmark: "Book a visit" is
    // on the family dashboard nav.
    await expect(page.getByText('Book a visit', { exact: false }).first()).toBeVisible({ timeout: 15_000 })
    expect(apiFailures, `Server errors: ${apiFailures.join(', ')}`).toEqual([])
  })
})
