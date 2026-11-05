// Server-only helpers for loading + caching practice settings.
//
// Lives at src/lib/ instead of api/_lib/ because Vercel's serverless
// function bundler does NOT follow imports into underscore-prefixed
// folders. Files under src/ ARE followed by Vercel's node-file-trace,
// so an api/ route importing from here gets the file packed into its
// deployment bundle. Sara + Claude 2026-11-05 (post-mortem of the
// Phase 1 Settings tab 500ing in prod).
//
// This file imports `neon` which is a node-runtime module. Client code
// must NEVER import from here — only from src/lib/practiceSettings.ts
// which is client-safe. Vite tree-shaking does not save us if a client
// file transitively pulls `neon` in.

import { neon } from '@neondatabase/serverless'
import type { VercelResponse } from '@vercel/node'
import {
  parsePracticeSettings,
  practiceSettingsSchema,
  type PracticeSettings,
} from './practiceSettings'

const CACHE_TTL_MS = 5 * 60 * 1000  // 5 min

type CacheEntry = { settings: PracticeSettings; loadedAt: number }
const cache = new Map<string, CacheEntry>()

/**
 * Load a practice's settings from the DB, with a 5-minute in-memory
 * cache keyed by practice_id. Falls back to PHC defaults if the row
 * is missing or FORCE_PHC_LEGACY env var is set.
 */
export async function getPracticeSettings(practiceId: string): Promise<PracticeSettings> {
  if (process.env.FORCE_PHC_LEGACY === 'true') {
    return practiceSettingsSchema.parse({})
  }

  const now = Date.now()
  const hit = cache.get(practiceId)
  if (hit && now - hit.loadedAt < CACHE_TTL_MS) {
    return hit.settings
  }

  const sql = neon(process.env.DATABASE_URL!)
  const [row] = await sql`
    SELECT settings FROM practices WHERE id = ${practiceId}::uuid LIMIT 1`

  const settings = parsePracticeSettings(row?.settings ?? null)
  cache.set(practiceId, { settings, loadedAt: now })
  return settings
}

/**
 * Drop a practice's settings from the in-memory cache. Call this
 * immediately after writing a settings change so the next read picks
 * up the new value without waiting for the TTL.
 */
export function invalidatePracticeSettings(practiceId: string): void {
  cache.delete(practiceId)
}

/**
 * Drop every entry — used by tests or if we ever expose a "refresh
 * all" admin button.
 */
export function clearPracticeSettingsCache(): void {
  cache.clear()
}

/**
 * Look up the practice_id tied to a Cognito sub, then load that
 * practice's settings. Centralized here so every API route uses the
 * same lookup path.
 *
 * Returns null if the sub doesn't map to a provider (caller should
 * 403 in that case).
 */
export async function getSettingsForSub(sub: string): Promise<{
  practiceId: string
  settings: PracticeSettings
} | null> {
  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`
    SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return null
  const practiceId = provider.practice_id as string
  const settings = await getPracticeSettings(practiceId)
  return { practiceId, settings }
}

/**
 * Server-side flag guard. Call at the top of any API route whose
 * entire operation is gated on one flag. When the flag is off for
 * this user's practice, the route short-circuits with a 403 and
 * a descriptive error.
 *
 *   const guarded = await requireFlag(sub, 'uses_cpr_classes', res)
 *   if (!guarded) return
 *
 * Returns the loaded settings object so the caller doesn't need a
 * second load for additional checks.
 */
export async function requireFlag(
  sub: string,
  flagKey: keyof PracticeSettings,
  res: VercelResponse,
): Promise<{ practiceId: string; settings: PracticeSettings } | null> {
  const loaded = await getSettingsForSub(sub)
  if (!loaded) {
    res.status(403).json({ error: 'Provider not found' })
    return null
  }
  if (!loaded.settings[flagKey]) {
    res.status(403).json({
      error: `This feature (${String(flagKey)}) is not enabled for your practice.`,
      flag: flagKey,
    })
    return null
  }
  return loaded
}
