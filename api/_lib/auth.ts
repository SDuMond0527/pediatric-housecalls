import sql from './db'
import { verifyToken } from './verifyToken'
import { verifyFamilyToken } from './verifyFamilyToken'

export interface ProviderContext {
  sub: string
  practiceId: string
  providerId: string
}

export interface FamilyContext {
  sub: string
  practiceId: string
  familyId: string
}

export async function getProviderContext(authHeader: string | undefined): Promise<ProviderContext> {
  const sub = await verifyToken(authHeader)
  const [provider] = await sql`SELECT id, practice_id FROM providers WHERE cognito_sub = ${sub}`
  if (!provider) throw new Error('Provider not found')
  return { sub, practiceId: provider.practice_id, providerId: provider.id }
}

export async function getFamilyContext(authHeader: string | undefined): Promise<FamilyContext> {
  const sub = await verifyFamilyToken(authHeader)
  const [family] = await sql`SELECT id, practice_id FROM family_profiles WHERE cognito_sub = ${sub}`
  if (!family) throw new Error('Family not found')
  return { sub, practiceId: family.practice_id, familyId: family.id }
}

// For endpoints that accept either provider or family tokens (e.g. appointments)
export async function getAnyContext(authHeader: string | undefined): Promise<{ sub: string; practiceId: string }> {
  // Try provider token first
  try {
    const ctx = await getProviderContext(authHeader)
    return { sub: ctx.sub, practiceId: ctx.practiceId }
  } catch {}
  // Fall back to family token
  const ctx = await getFamilyContext(authHeader)
  return { sub: ctx.sub, practiceId: ctx.practiceId }
}
