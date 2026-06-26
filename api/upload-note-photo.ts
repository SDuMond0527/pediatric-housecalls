import type { VercelRequest, VercelResponse } from '@vercel/node'
import { put } from '@vercel/blob'
import { getProviderContext } from './_lib/auth'

export const config = { api: { bodyParser: false } }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try { await getProviderContext(req.headers.authorization) } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const filename = (req.query.filename as string) || `photo-${Date.now()}.jpg`
  const contentType = (req.headers['content-type'] as string) || 'image/jpeg'

  const blob = await put(`note-photos/${Date.now()}-${filename}`, req as any, {
    access: 'public',
    contentType,
  })

  return res.json({ url: blob.url })
}
