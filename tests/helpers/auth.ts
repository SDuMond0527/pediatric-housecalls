import type { Page } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

// Load tests/.env manually — small enough not to need a dedicated dotenv package.
// tests/.env is gitignored; real credentials live only on the local machine
// (or in GitHub Actions secrets for CI).
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
 * Log in as a provider or admin. Uses TEST_ADMIN_EMAIL + TEST_ADMIN_PASSWORD.
 * (Sara uses one account for both admin and clinical roles per her setup.)
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  const email = requireEnv('TEST_ADMIN_EMAIL')
  const password = requireEnv('TEST_ADMIN_PASSWORD')

  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: /sign in to provider portal/i }).click()

  // Wait for the landing page to appear — a provider always lands somewhere
  // that has "Add appointment" or the schedule header.
  await page.waitForURL(/\/(today|schedule|patients|admin)/, { timeout: 15_000 })
}

/**
 * Log in as a family (parent). Uses TEST_FAMILY_EMAIL + TEST_FAMILY_PASSWORD.
 */
export async function loginAsFamily(page: Page): Promise<void> {
  const email = requireEnv('TEST_FAMILY_EMAIL')
  const password = requireEnv('TEST_FAMILY_PASSWORD')

  await page.goto('/family/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()

  await page.waitForURL(/\/family\/(dashboard|book|home|profile)/, { timeout: 15_000 })
}
