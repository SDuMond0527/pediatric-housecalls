import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { FamilyProfile, Child } from '../types/family'

interface FamilyAuthContextType {
  user: User | null
  session: Session | null
  family: FamilyProfile | null
  children: Child[]
  loading: boolean
  signUp: (email: string, password: string) => Promise<{ error: Error | null; needsConfirmation: boolean }>
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>
  signOut: () => Promise<void>
  refreshFamily: () => Promise<void>
}

const FamilyAuthContext = createContext<FamilyAuthContextType | null>(null)

export function FamilyAuthProvider({ children: contextChildren }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [family, setFamily] = useState<FamilyProfile | null>(null)
  const [children, setChildren] = useState<Child[]>([])
  const [loading, setLoading] = useState(true)

  async function fetchFamily(userId: string) {
    const [{ data: profileRows }, { data: kids }] = await Promise.all([
      supabase.from('family_profiles').select('*').eq('id', userId).limit(1),
      supabase.from('children').select('*').eq('family_id', userId).order('created_at'),
    ])
    if (profileRows && profileRows.length > 0) setFamily(profileRows[0] as FamilyProfile)
    setChildren((kids ?? []) as Child[])
  }

  async function refreshFamily() {
    if (user) await fetchFamily(user.id)
  }

  useEffect(() => {
    // Wait for fetchFamily to complete before clearing loading
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session)
      setUser(session?.user ?? null)
      if (session?.user) await fetchFamily(session.user.id)
      setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setSession(session)
      setUser(session?.user ?? null)
      if (session?.user) {
        setLoading(true)
        fetchFamily(session.user.id).finally(() => setLoading(false))
      } else {
        setFamily(null)
        setChildren([])
        setLoading(false)
      }
    })
    return () => subscription.unsubscribe()
  }, [])

  async function signUp(email: string, password: string) {
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (!error && data.user) {
      await supabase.from('family_profiles').upsert({
        id: data.user.id,
        email: data.user.email ?? '',
      })
    }
    // session is null when Supabase requires email confirmation
    const needsConfirmation = !error && !data.session
    return { error: error as Error | null, needsConfirmation }
  }

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error as Error | null }
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <FamilyAuthContext.Provider value={{ user, session, family, children, loading, signUp, signIn, signOut, refreshFamily }}>
      {contextChildren}
    </FamilyAuthContext.Provider>
  )
}

export function useFamilyAuth() {
  const ctx = useContext(FamilyAuthContext)
  if (!ctx) throw new Error('useFamilyAuth must be used within FamilyAuthProvider')
  return ctx
}
