import { configureForFamilies } from '../lib/amplify'
import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { signUp as cognitoSignUp } from 'aws-amplify/auth'
import type { FamilyProfile, Child } from '../types/family'

const TOKEN_KEY = 'family_auth'

interface StoredTokens {
  accessToken: string
  idToken: string
  refreshToken: string
  email: string
  sub: string
  expiresAt: number
}

function parseJwt(token: string): Record<string, unknown> {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(base64))
  } catch { return {} }
}

function getStoredTokens(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    if (!raw) return null
    const tokens = JSON.parse(raw) as StoredTokens
    if (Date.now() > tokens.expiresAt) { localStorage.removeItem(TOKEN_KEY); return null }
    return tokens
  } catch { return null }
}

export async function getFamilyAccessToken(): Promise<string> {
  return getStoredTokens()?.accessToken ?? ''
}

interface CognitoUser { id: string; email?: string }

interface FamilyAuthContextType {
  user: CognitoUser | null
  family: FamilyProfile | null
  children: Child[]
  loading: boolean
  signUp: (email: string, password: string) => Promise<{ error: Error | null; needsConfirmation: boolean }>
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>
  signOut: () => Promise<void>
  refreshFamily: () => Promise<void>
}

const FamilyAuthContext = createContext<FamilyAuthContextType | null>(null)

async function fetchFamilyData(accessToken: string): Promise<{ family: FamilyProfile; children: Child[] } | null> {
  const res = await fetch('/api/families/me', { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) return null
  return res.json()
}

export function FamilyAuthProvider({ children: contextChildren }: { children: ReactNode }) {
  configureForFamilies()
  const [user, setUser] = useState<CognitoUser | null>(null)
  const [family, setFamily] = useState<FamilyProfile | null>(null)
  const [children, setChildren] = useState<Child[]>([])
  const [loading, setLoading] = useState(true)

  async function loadUser() {
    const tokens = getStoredTokens()
    if (!tokens) { setUser(null); setFamily(null); setChildren([]); setLoading(false); return }
    setUser({ id: tokens.sub, email: tokens.email })
    try {
      const data = await fetchFamilyData(tokens.accessToken)
      if (data) { setFamily(data.family); setChildren(data.children) }
    } catch { /* family fetch failure doesn't block auth */ }
    setLoading(false)
  }

  async function refreshFamily() {
    const tokens = getStoredTokens()
    if (!tokens) return
    const data = await fetchFamilyData(tokens.accessToken)
    if (data) { setFamily(data.family); setChildren(data.children) }
  }

  useEffect(() => { loadUser() }, [])

  async function signIn(email: string, password: string) {
    try {
      const res = await fetch('/api/families/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: email, password }),
      })
      if (!res.ok) {
        const { error } = await res.json()
        return { error: new Error(error || 'Invalid email or password') }
      }
      const { accessToken, idToken, expiresIn } = await res.json()
      const payload = parseJwt(accessToken)
      const idPayload = parseJwt(idToken)
      const tokens: StoredTokens = {
        accessToken, idToken,
        refreshToken: '',
        sub: payload.sub as string,
        email: idPayload.email as string ?? email,
        expiresAt: Date.now() + (expiresIn as number) * 1000,
      }
      localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens))
      setUser({ id: tokens.sub, email: tokens.email })
      const data = await fetchFamilyData(accessToken)
      if (data) { setFamily(data.family); setChildren(data.children) }
      return { error: null }
    } catch (e) {
      return { error: e as Error }
    }
  }

  async function signUp(email: string, password: string) {
    try {
      const result = await cognitoSignUp({ username: email, password, options: { userAttributes: { email } } })
      if (result.nextStep.signUpStep === 'CONFIRM_SIGN_UP') {
        const confirmRes = await fetch('/api/families/confirm-signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: email }),
        })
        if (!confirmRes.ok) {
          const { error } = await confirmRes.json()
          return { error: new Error(error || 'Could not confirm account'), needsConfirmation: false }
        }
      }
      const { error } = await signIn(email, password)
      if (error) return { error, needsConfirmation: false }
      return { error: null, needsConfirmation: false }
    } catch (e) {
      return { error: e as Error, needsConfirmation: false }
    }
  }

  async function signOut() {
    localStorage.removeItem(TOKEN_KEY)
    setUser(null); setFamily(null); setChildren([])
  }

  return (
    <FamilyAuthContext.Provider value={{ user, family, children, loading, signUp, signIn, signOut, refreshFamily }}>
      {contextChildren}
    </FamilyAuthContext.Provider>
  )
}

export function useFamilyAuth() {
  const ctx = useContext(FamilyAuthContext)
  if (!ctx) throw new Error('useFamilyAuth must be used within FamilyAuthProvider')
  return ctx
}
