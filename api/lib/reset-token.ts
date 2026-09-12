import { createHmac, timingSafeEqual } from 'crypto'

const SECRET = process.env.PASSWORD_RESET_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'dev-reset-secret'

export function generateResetToken(email: string, userType: 'family' | 'provider'): string {
  const payload = { email, userType, exp: Date.now() + 3_600_000 } // 1 hour
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', SECRET).update(data).digest('base64url')
  return `${data}.${sig}`
}

export function verifyResetToken(token: string): { email: string; userType: 'family' | 'provider' } | null {
  if (!token) return null
  const dotIdx = token.lastIndexOf('.')
  if (dotIdx === -1) return null
  const data = token.slice(0, dotIdx)
  const sig = token.slice(dotIdx + 1)
  const expectedSig = createHmac('sha256', SECRET).update(data).digest('base64url')
  const a = Buffer.from(sig), b = Buffer.from(expectedSig)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString())
    if (Date.now() > parsed.exp) return null
    if (!parsed.email || !parsed.userType) return null
    return { email: parsed.email, userType: parsed.userType }
  } catch { return null }
}
