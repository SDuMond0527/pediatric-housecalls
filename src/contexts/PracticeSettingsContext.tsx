// Client-side practice settings context. Loads the logged-in provider's
// practice settings once at mount and exposes them via useSettings().
//
// Phase 1 note: this is scaffolding. The settings are loaded and
// available, but no UI code reads them yet — flag-gating is Phase 2.
// So mounting this provider is a no-op for users today.
//
// Sara 2026-11-04.

import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { fetchAuthSession } from 'aws-amplify/auth'
import { parsePracticeSettings, type PracticeSettings } from '../lib/practiceSettings'

interface PracticeSettingsContextType {
  settings: PracticeSettings
  practiceId: string | null
  loading: boolean
  reload: () => Promise<void>
}

// Default context value is "parsed empty blob" = all PHC defaults. If
// the context is read before load finishes (or without a provider), we
// return PHC behavior. Safe fallback.
const defaultSettings = parsePracticeSettings({})

const PracticeSettingsContext = createContext<PracticeSettingsContextType>({
  settings: defaultSettings,
  practiceId: null,
  loading: true,
  reload: async () => {},
})

async function fetchSettings(): Promise<{ practice_id: string; settings: PracticeSettings } | null> {
  try {
    const session = await fetchAuthSession()
    const token = session.tokens?.accessToken?.toString() ?? ''
    if (!token) return null
    const res = await fetch('/api/practice-settings', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const json = await res.json()
    return { practice_id: json.practice_id, settings: parsePracticeSettings(json.settings) }
  } catch {
    return null
  }
}

export function PracticeSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PracticeSettings>(defaultSettings)
  const [practiceId, setPracticeId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = async () => {
    const result = await fetchSettings()
    if (result) {
      setSettings(result.settings)
      setPracticeId(result.practice_id)
    }
    setLoading(false)
  }

  useEffect(() => { void reload() }, [])

  return (
    <PracticeSettingsContext.Provider value={{ settings, practiceId, loading, reload }}>
      {children}
    </PracticeSettingsContext.Provider>
  )
}

export function useSettings(): PracticeSettingsContextType {
  return useContext(PracticeSettingsContext)
}

// ─── Flag primitives (Phase 2) ─────────────────────────────────────────
// Three small helpers the chunks reuse. Each respects the "while loading
// settings, return PHC defaults" rule — nothing hides while we're still
// figuring out who the user is.

/** Get the current value of a single flag by key. */
export function useFlag<K extends keyof PracticeSettings>(key: K): PracticeSettings[K] {
  const { settings } = useSettings()
  return settings[key]
}

/** Renders children only when the flag is true. Simplest form:
 *  <FlagGate flag="uses_cpr_classes"><CPRNavItem /></FlagGate>
 *  Also accepts a `fallback` prop to render something else when off.
 */
export function FlagGate({
  flag,
  children,
  fallback = null,
}: {
  flag: keyof PracticeSettings
  children: ReactNode
  fallback?: ReactNode
}) {
  const value = useFlag(flag)
  return value ? <>{children}</> : <>{fallback}</>
}

/** Route-level guard. When the flag is off, redirects to `redirectTo`
 *  (default "/today"). Prevents users from landing on a page for a
 *  feature their practice has disabled by typing the URL directly.
 *  While settings load, children render (= PHC defaults) so there's no
 *  flash-of-empty for a legit PHC user during auth bootstrap.
 */
export function FlagGuardedRoute({
  flag,
  children,
  redirectTo = '/today',
}: {
  flag: keyof PracticeSettings
  children: ReactNode
  redirectTo?: string
}) {
  const { settings, loading } = useSettings()
  if (loading) return <>{children}</>
  if (!settings[flag]) return <Navigate to={redirectTo} replace />
  return <>{children}</>
}
