# Automated tests

End-to-end tests that click through the deployed app in a real browser
(headless Chrome via [Playwright](https://playwright.dev)) to verify critical
paths work. Every push runs them via GitHub Actions.

## What they cover

Currently **read-only** — the tests log in and view pages but never create,
update, or delete data. This is safe to run against production.

- Admin schedule page loads, `/api/appointments` returns 200
- Provider Today view loads, stat cards render
- Family portal loads (dashboard, vaccines, visit history)
- Patient chart loads, every tab (Overview / Appointments / Encounters /
  Vaccines / Prescribe / Labs / Growth Chart) is clickable without a 500
- Analytics page loads with KPI cards + on-call widget
- Encounter note opens with Procedures & Fees / Diagnoses sections
- Vaccines tab renders (either table or empty state)
- Waitlist and Broadcasts pages load

## Running locally

1. Copy the credentials template:
   ```bash
   cp tests/.env.example tests/.env
   ```

2. Edit `tests/.env` and fill in real values. `tests/.env` is git-ignored;
   it never leaves your machine.

3. Install Playwright browsers once (already in package-lock, but browsers
   are downloaded separately):
   ```bash
   npx playwright install chromium
   ```

4. Run the suite:
   ```bash
   npm test           # headless, prints results
   npm run test:ui    # interactive UI mode for debugging
   npm run test:report # open the last HTML report
   ```

## Running against a preview deploy

Every git branch gets its own Vercel preview URL. To test a branch before
merging to `main`:

```bash
BASE_URL=https://roam-platform-git-YOUR-BRANCH.vercel.app npm test
```

If tests pass on the preview URL, merging to `main` is safe.

## Adding a new test

Create a new `*.spec.ts` file in `tests/`. Import from `./helpers/auth` for
the shared login helpers.

Read-only test template:

```typescript
import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/auth'

test('some page loads without a 500', async ({ page }) => {
  const apiFailures: string[] = []
  page.on('response', res => {
    if (res.url().includes('/api/') && res.status() >= 500) {
      apiFailures.push(`${res.status()} on ${res.url()}`)
    }
  })

  await loginAsAdmin(page)
  await page.goto('/some/path')

  await expect(page.getByText(/expected landmark/i)).toBeVisible()
  expect(apiFailures).toEqual([])
})
```

## GitHub Actions

`.github/workflows/tests.yml` runs the suite on every push to `main` and every
PR. Credentials come from GitHub repo secrets:

- `TEST_ADMIN_EMAIL`
- `TEST_ADMIN_PASSWORD`
- `TEST_FAMILY_EMAIL`
- `TEST_FAMILY_PASSWORD`
- `TEST_BASE_URL` (optional; defaults to production)

Set these in GitHub → repo Settings → Secrets and variables → Actions.

Currently CI failure does NOT block Vercel deployment — it just flags the
regression on GitHub so we know a bad deploy shipped. Adding a hard deploy
gate is a small follow-up when we're ready.

## Not yet covered (deferred to phase 2)

These tests mutate data, so they'll create a "TEST" appointment/booking
that gets cleaned up after. Not included in the initial suite:

- Family self-book flow end-to-end
- Cancel appointment (family + admin paths)
- Reschedule appointment
- Encounter note save + sign
- Vaccine entry save + display
- CMA + telemedicine auto-pair with on-call MD/NP

When we're ready for phase 2, each mutating test will:
1. Create data with obviously-marked "AUTOMATED TEST" notes
2. Run assertions
3. Delete the created data in a `test.afterEach` cleanup step
