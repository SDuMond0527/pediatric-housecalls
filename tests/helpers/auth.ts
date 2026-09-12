import type { Page } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

// Load tests/.env manually — small enough not to need a dedicated dotenv package.
// tests/.env is gitignored; real credentials live only on the local machine
// (or in GitHub Actions secrets for CI).
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const envPath = path.resolve(__dirname, '..', '.env')
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, '')
    if (!(key in process.env)) process.env[key] = value
  }
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    throw new Error(
      `Missing ${name} — copy tests/.env.example to tests/.env and fill in real values before running tests.`,
    )
  }
  return v
}

/**
 * Wrap `page.waitForURL` so a timeout produces an ACTIONABLE failure
 * message instead of "waitForURL: timeout." Captures the current URL,
 * whatever error banner text is on the page, and the login button's
 * enabled state. Without this, every Playwright failure email tonight
 * has been useless — we only knew the wait timed out, not why.
 */
async function waitForUrlOrExplain(page: Page, pattern: RegExp, ctx: string): Promise<void> {
  try {
    await page.waitForURL(pattern, { timeout: 15_000 })
  } catch (err) {
    const url = page.url()
    const errorBanner = await page.locator('.bg-\\[\\#FCEBEB\\], [role="alert"]').first().textContent().catch(() => '')
    const bodySnippet = (await page.locator('body').textContent().catch(() => '') || '').slice(0, 400).replace(/\s+/g, ' ').trim()
    throw new Error(
      `${ctx} timed out waiting for URL ${pattern}.\n` +
      `  Current URL: ${url}\n` +
      `  Error banner: ${(errorBanner || '').trim() || '(none)'}\n` +
      `  Body snippet: ${bodySnippet}\n` +
      `  Original: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Log in as a provider or admin. Uses TEST_ADMIN_EMAIL + TEST_ADMIN_PASSWORD.
 * (Sara uses one account for both admin and clinical roles per her setup.)
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  const email = requireEnv('TEST_ADMIN_EMAIL')
  const password = requireEnv('TEST_ADMIN_PASSWORD')

  await page.goto('/login')
  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').first().fill(password)
  await page.getByRole('button', { name: /sign in to provider portal/i }).click()

  await waitForUrlOrExplain(page, /\/(today|schedule|patients|admin)/, 'loginAsAdmin')
}

/**
 * Log in as a family (parent). Uses TEST_FAMILY_EMAIL + TEST_FAMILY_PASSWORD.
 */
export async function loginAsFamily(page: Page): Promise<void> {
  const email = requireEnv('TEST_FAMILY_EMAIL')
  const password = requireEnv('TEST_FAMILY_PASSWORD')

  await page.goto('/family/login')
  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').first().fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()

  await waitForUrlOrExplain(page, /\/family\/(dashboard|book|home|profile)/, 'loginAsFamily')
}
