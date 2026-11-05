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
