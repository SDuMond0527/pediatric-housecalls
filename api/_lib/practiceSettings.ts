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
