// Server-side helper to load a practice's settings blob, with an
// in-memory cache so the DB isn't hit on every request.
//
// Lives at api/_lib/ (underscore prefix keeps Vercel from routing to
// it — only files directly under api/ or api/<route>/ become endpoints).
//
// Phase 1: this helper EXISTS but is only called by the new super-admin
// Settings tab (to render current values) and the audit endpoint. No
// existing PHC feature calls it yet. That wiring is Phase 2.
//
// Kill switch: FORCE_PHC_LEGACY=true in env → every call returns the
// schema-default blob (all PHC flags ON). Lets us revert to pre-Phase-2
// behavior instantly if Phase 2 ever ships a regression. Sara 2026-11-04.

import { neon } from '@neondatabase/serverless'
import type { VercelResponse } from '@vercel/node'
import {
  parsePracticeSettings,
  practiceSettingsSchema,
  type PracticeSettings,
} from '../../src/lib/practiceSettings'

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
