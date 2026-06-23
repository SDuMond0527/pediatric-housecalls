import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyFamilyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

export const config = { api: { bodyParser: false } }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    await verifyFamilyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: 'Storage not configured' })
  }

  // Read raw body
  const chunks: Buffer[] = []
  for await (const chunk of req as any) chunks.push(chunk)
  const body = Buffer.concat(chunks)

  // Parse Content-Type for boundary
  const contentType = req.headers['content-type'] || ''
  if (!contentType.includes('multipart/form-data')) {
    return res.status(400).json({ error: 'Expected multipart/form-data' })
  }

  const boundary = contentType.split('boundary=')[1]
  if (!boundary) return res.status(400).json({ error: 'Missing boundary' })

  // Parse multipart body
  const parts = parseMultipart(body, boundary)
  const filePart = parts.find(p => p.name === 'file')
  const pathPart = parts.find(p => p.name === 'path')

  if (!filePart || !pathPart) return res.status(400).json({ error: 'Missing file or path' })

  const storagePath = pathPart.data.toString()
  const mimeType = filePart.contentType || 'image/jpeg'

  // Upload via Supabase Storage REST API using service role key
  const uploadUrl = `${supabaseUrl}/storage/v1/object/insurance-cards/${storagePath}`
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'apikey': serviceRoleKey,
      'Content-Type': mimeType,
      'x-upsert': 'true',
    },
    body: new Uint8Array(filePart.data),
  })

  if (!uploadRes.ok) {
    const err = await uploadRes.json().catch(() => ({ message: uploadRes.statusText }))
    return res.status(uploadRes.status).json({ error: err.message || 'Upload failed' })
  }

  const publicUrl = `${supabaseUrl}/storage/v1/object/public/insurance-cards/${storagePath}`
  return res.json({ publicUrl })
}

function parseMultipart(body: Buffer, boundary: string): Array<{ name: string; contentType: string; data: Buffer }> {
  const sep = Buffer.from(`--${boundary}`)
  const parts: Array<{ name: string; contentType: string; data: Buffer }> = []
  let start = 0

  while (start < body.length) {
    const sepIdx = body.indexOf(sep, start)
    if (sepIdx === -1) break
    start = sepIdx + sep.length
    if (body[start] === 45 && body[start + 1] === 45) break // --boundary--

    // Skip \r\n after boundary
    if (body[start] === 13) start += 2

    // Find end of headers
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), start)
    if (headerEnd === -1) break
    const headerStr = body.slice(start, headerEnd).toString()
    start = headerEnd + 4

    // Find next boundary
    const nextSep = body.indexOf(sep, start)
    const dataEnd = nextSep === -1 ? body.length : nextSep - 2 // strip trailing \r\n
    const data = body.slice(start, dataEnd)

    const nameMatch = headerStr.match(/name="([^"]+)"/)
    const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/)
    if (nameMatch) {
      parts.push({ name: nameMatch[1], contentType: ctMatch?.[1] || '', data })
    }
    start = nextSep === -1 ? body.length : nextSep
  }

  return parts
}
