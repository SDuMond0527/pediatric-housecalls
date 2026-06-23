import { configureForProviders } from '../lib/amplify'
import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  getCurrentUser,
  signIn as cognitoSignIn,
  signOut as cognitoSignOut,
  confirmSignIn,
  fetchAuthSession,
} from 'aws-amplify/auth'
import { Hub } from 'aws-amplify/utils'
import type { Provider } from '../types'

interface CognitoUser {
  id: string
  email?: string
}

interface AuthContextType {
  user: CognitoUser | null
  provider: Provider | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<{ error: Error | null; needsNewPassword: boolean }>
  confirmNewPassword: (newPassword: string) => Promise<{ error: Error | null }>
  signOut: () => Promise<void>
  refreshProvider: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | null>(null)

async function getAccessToken(): Promise<string> {
  const session = await fetchAuthSession()
  return session.tokens?.accessToken?.toString() ?? ''
}

async function fetchProvider(): Promise<Provider | null> {
  const token = await getAccessToken()
  const res = await fetch('/api/providers/me', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  return res.json()
}

export function AuthProvider({ children }: { children: ReactNode }) {
  configureForProviders()
  const [user, setUser] = useState<CognitoUser | null>(null)
  const [provider, setProvider] = useState<Provider | null>(null)
  const [loading, setLoading] = useState(true)

  async function loadUser() {
    try {
      const cognitoUser = await getCurrentUser()
      setUser({ id: cognitoUser.userId })
      // Provider fetch failure should not clear the authenticated user
      try {
        const p = await fetchProvider()
        setProvider(p)
      } catch {
        setProvider(null)
      }
    } catch {
      // Not authenticated
      setUser(null)
      setProvider(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadUser()
    const unsubscribe = Hub.listen('auth', ({ payload }) => {
      if (payload.event === 'signedIn') loadUser()
      if (payload.event === 'signedOut') {
        setUser(null)
        setProvider(null)
      }
    })
    return unsubscribe
  }, [])

  async function signIn(email: string, password: string) {
    try {
      const result = await cognitoSignIn({ username: email, password })
      if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        return { error: null, needsNewPassword: true }
      }
      await loadUser()
      return { error: null, needsNewPassword: false }
    } catch (e: unknown) {
      // Already signed in (e.g. after confirmSignIn) — just load the user
      if ((e as { name?: string }).name === 'UserAlreadyAuthenticatedException') {
        await loadUser()
        return { error: null, needsNewPassword: false }
      }
      return { error: e as Error, needsNewPassword: false }
    }
  }

  async function confirmNewPassword(newPassword: string) {
    try {
      await confirmSignIn({ challengeResponse: newPassword })
      await loadUser()
      return { error: null }
    } catch (e) {
      return { error: e as Error }
    }
  }

  async function signOut() {
    await cognitoSignOut()
  }

  async function refreshProvider() {
    const p = await fetchProvider().catch(() => null)
    setProvider(p)
  }

  return (
    <AuthContext.Provider value={{ user, provider, loading, signIn, confirmNewPassword, signOut, refreshProvider }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export { getAccessToken }
