import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Short-form dictation endpoint. The browser records a few seconds of
// audio with MediaRecorder, POSTs the raw blob here, we forward it to
// Deepgram's nova-2-medical model, and return the transcript so the
// client can append it to the encounter-note field.
//
// Deepgram pricing (medical model, synchronous): ~$0.0043/min. Short
// per-field dictations run 5-30 seconds each. Budget: ~$5/mo for the
// practice at normal volumes. Sara 2026-11-09.

async function verifyProviderToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

export const config = {
  api: {
    bodyParser: false, // we stream the raw audio bytes through unchanged
  },
}

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Only authenticated providers can burn Deepgram credits.
  try { await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const apiKey = process.env.DEEPGRAM_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'DEEPGRAM_API_KEY not configured' })

  let audio: Buffer
  try {
    audio = await readRawBody(req)
  } catch (e: any) {
    return res.status(400).json({ error: 'Failed to read audio body: ' + (e?.message ?? String(e)) })
  }
  if (audio.length === 0) return res.status(400).json({ error: 'Empty audio body' })
  // Cap at 10 MB — half a minute of medical-grade audio is <2 MB; anything
  // bigger is a wrong-sized recording or a bug on the client.
  if (audio.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'Audio too large (max 10 MB)' })

  const contentType = String(req.headers['content-type'] || 'audio/webm')

  // Deepgram synchronous transcription. Medical-tuned Nova-2 model, with
  // smart_format for punctuation + sentence casing, and numerals for
  // vitals ("140 over 90" → "140/90").
  const url = new URL('https://api.deepgram.com/v1/listen')
  url.searchParams.set('model', 'nova-2-medical')
  url.searchParams.set('smart_format', 'true')
  url.searchParams.set('punctuate', 'true')
  url.searchParams.set('numerals', 'true')

  let dgRes: Response
  try {
    dgRes = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': contentType,
      },
      body: audio as any,
    })
  } catch (e: any) {
    return res.status(502).json({ error: 'Deepgram unreachable: ' + (e?.message ?? String(e)) })
  }

  if (!dgRes.ok) {
    const body = await dgRes.text().catch(() => '')
    return res.status(502).json({ error: `Deepgram error ${dgRes.status}: ${body.slice(0, 300)}` })
  }

  let payload: any
  try { payload = await dgRes.json() }
  catch (e: any) { return res.status(502).json({ error: 'Deepgram returned non-JSON: ' + (e?.message ?? String(e)) }) }

  const transcript: string =
    payload?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
  return res.status(200).json({ transcript: transcript.trim() })
}
