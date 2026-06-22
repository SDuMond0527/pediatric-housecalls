import { createRemoteJWKSet, jwtVerify } from 'jose'

export async function verifyFamilyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)

  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(
    new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`)
  )

  const { payload } = await jwtVerify(token, JWKS, {
    issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
  })
  const sub = payload.sub
  if (!sub) throw new Error('No sub in token')
  return sub
}
