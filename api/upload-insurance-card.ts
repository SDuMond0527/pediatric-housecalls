import type { VercelRequest, VercelResponse } from '@vercel/node'
import { put } from '@vercel/blob'
import { getFamilyContext } from './_lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    await getFamilyContext(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { data, filename } = req.body as { data: string; filename: string }
  if (!data || !filename) return res.status(400).json({ error: 'Missing data or filename' })

  const matches = data.match(/^data:([^;]+);base64,(.+)$/)
  if (!matches) return res.status(400).json({ error: 'Invalid image data' })
  const [, contentType, base64] = matches
  const buffer = Buffer.from(base64, 'base64')

  try {
    const blob = await put(filename, buffer, { access: 'public', contentType })
    return res.json({ url: blob.url })
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? 'Upload failed' })
  }
}
