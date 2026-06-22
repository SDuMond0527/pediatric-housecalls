import { configureForFamilies } from '../lib/amplify'
configureForFamilies()
import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  getCurrentUser,
  signIn as cognitoSignIn,
  signOut as cognitoSignOut,
  signUp as cognitoSignUp,
  fetchAuthSession,
} from 'aws-amplify/auth'
import { Hub } from 'aws-amplify/utils'
import type { FamilyProfile, Child } from '../types/family'

interface CognitoUser {
  id: string      // Cognito sub
  email?: string
}

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

async function getFamilyAccessToken(): Promise<string> {
  const session = await fetchAuthSession()
  return session.tokens?.accessToken?.toString() ?? ''
}

async function fetchFamilyData(): Promise<{ family: FamilyProfile; children: Child[] } | null> {
  const token = await getFamilyAccessToken()
  const res = await fetch('/api/families/me', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404) return null
  if (!res.ok) return null
  return res.json()
}

export function FamilyAuthProvider({ children: contextChildren }: { children: ReactNode }) {
  const [user, setUser] = useState<CognitoUser | null>(null)
  const [family, setFamily] = useState<FamilyProfile | null>(null)
  const [children, setChildren] = useState<Child[]>([])
  const [loading, setLoading] = useState(true)

  async function loadUser() {
    try {
      const cognitoUser = await getCurrentUser()
      const session = await fetchAuthSession()
      const email = session.tokens?.idToken?.payload?.email as string | undefined
      setUser({ id: cognitoUser.userId, email })
      const data = await fetchFamilyData()
      if (data) {
        setFamily(data.family)
        setChildren(data.children)
      }
    } catch {
      setUser(null)
      setFamily(null)
      setChildren([])
    } finally {
      setLoading(false)
    }
  }

  async function refreshFamily() {
    const data = await fetchFamilyData()
    if (data) {
      setFamily(data.family)
      setChildren(data.children)
    }
  }

  useEffect(() => {
    loadUser()
    const unsubscribe = Hub.listen('auth', ({ payload }) => {
      if (payload.event === 'signedIn') loadUser()
      if (payload.event === 'signedOut') {
        setUser(null)
        setFamily(null)
        setChildren([])
      }
    })
    return unsubscribe
  }, [])

  async function signUp(email: string, password: string) {
    try {
      const result = await cognitoSignUp({
        username: email,
        password,
        options: { userAttributes: { email } },
      })
      if (result.nextStep.signUpStep === 'CONFIRM_SIGN_UP') {
        // Auto-confirm via server so families don't need email verification
        const confirmRes = await fetch('/api/families/confirm-signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: email }),
        })
        if (!confirmRes.ok) {
          const { error } = await confirmRes.json()
          return { error: new Error(error || 'Could not confirm account'), needsConfirmation: false }
        }
        await cognitoSignIn({ username: email, password })
        await loadUser()
      }
      return { error: null, needsConfirmation: false }
    } catch (e) {
      return { error: e as Error, needsConfirmation: false }
    }
  }

  async function signIn(email: string, password: string) {
    try {
      await cognitoSignIn({ username: email, password })
      return { error: null }
    } catch (e) {
      return { error: e as Error }
    }
  }

  async function signOut() {
    await cognitoSignOut()
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

export { getFamilyAccessToken }
