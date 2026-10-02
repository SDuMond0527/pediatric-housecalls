import type { VercelRequest, VercelResponse } from '@vercel/node'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

type Role = 'provider' | 'family'
interface AuthResult { role: Role; sub: string }

async function verifyProvider(token: string): Promise<string | null> {
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  if (!poolId) return null
  try {
    const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
    const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
    return (payload.sub as string) || null
  } catch { return null }
}

async function verifyFamily(token: string): Promise<string | null> {
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  if (!poolId) return null
  try {
    const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
    const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
    return (payload.sub as string) || null
  } catch { return null }
}

async function verifyEitherPool(token: string): Promise<AuthResult | null> {
  const providerSub = await verifyProvider(token)
  if (providerSub) return { role: 'provider', sub: providerSub }
  const familySub = await verifyFamily(token)
  if (familySub) return { role: 'family', sub: familySub }
  return null
}

/**
 * POST /api/patient-reports/upload-token — direct-to-blob upload token
 * for lab + radiology report PDFs. Accepts BOTH provider and family
 * Cognito pools because parents upload from the family portal and
 * clinicians upload from the provider/admin chart view (same files,
 * same table, same storage).
 *
 * The browser passes the access token via clientPayload so this handler
 * can verify auth before issuing a Blob signing token. We also verify
 * child ownership here (provider → child.practice_id, family →
 * child.family_id) so we never issue a token for a child the uploader
 * can't legitimately touch.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const body = req.body as HandleUploadBody
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req as unknown as Request,
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        let accessToken = ''
        let childId = ''
        let kind: 'lab' | 'radiology' | '' = ''
        try {
          const parsed = JSON.parse(clientPayload || '{}')
          accessToken = String(parsed.accessToken ?? '')
          childId     = String(parsed.child_id ?? '')
          kind        = parsed.kind === 'lab' || parsed.kind === 'radiology' ? parsed.kind : ''
        } catch { /* fall through — rejection below */ }

        if (!accessToken) throw new Error('Missing access token')
        if (!childId)     throw new Error('Missing child_id')
        if (!kind)        throw new Error('kind must be "lab" or "radiology"')

        const auth = await verifyEitherPool(accessToken)
        if (!auth) throw new Error('Unauthorized')

        const sql = neon(process.env.DATABASE_URL!)
        if (auth.role === 'provider') {
          const [prov] = await sql`SELECT id, practice_id FROM providers WHERE cognito_sub = ${auth.sub} LIMIT 1`
          if (!prov) throw new Error('Provider not found')
          const [c] = await sql`SELECT 1 AS ok FROM children WHERE id = ${childId}::uuid AND practice_id = ${prov.practice_id}::uuid LIMIT 1`
          if (!c) throw new Error('Child not in your practice')
        } else {
          const [fam] = await sql`SELECT id FROM family_profiles WHERE cognito_sub = ${auth.sub} LIMIT 1`
          if (!fam) throw new Error('Family not found')
          const [c] = await sql`SELECT 1 AS ok FROM children WHERE id = ${childId}::uuid AND family_id = ${fam.id}::uuid LIMIT 1`
          if (!c) throw new Error('Child not in your family')
        }

        return {
          allowedContentTypes: undefined, // PDFs, images, text — accept any format a lab/imaging center hands out
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ sub: auth.sub, role: auth.role, child_id: childId, kind }),
        }
      },
      onUploadCompleted: async ({ blob }) => {
        // No-op; the client POSTs to /api/patient-reports right after
        // upload() resolves to create the DB row with uploader + title.
        console.log('[patient-reports] blob landed:', blob.url)
      },
    })
    return res.status(200).json(jsonResponse)
  } catch (e: any) {
    console.error('[patient-reports/upload-token] failed:', e?.message)
    return res.status(400).json({ error: e?.message ?? 'Upload token failed' })
  }
}
