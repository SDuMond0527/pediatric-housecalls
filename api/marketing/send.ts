import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createHmac } from 'crypto'
import { resolveAudience, type MarketingFilters } from './audience'

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const FROM_EMAIL     = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
const PRACTICE_NAME  = process.env.PRACTICE_NAME || 'Pediatric Housecalls'
const PORTAL_URL     = process.env.PORTAL_URL || 'https://phc-team.com'
const UNSUB_SECRET   = process.env.MARKETING_UNSUBSCRIBE_SECRET || process.env.INTERNAL_SERVICE_TOKEN || ''

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

function unsubscribeToken(familyId: string): string {
  return createHmac('sha256', UNSUB_SECRET).update(familyId).digest('hex').slice(0, 32)
}

function wrapHtml(bodyHtml: string, unsubUrl: string): string {
  // Minimal wrapper that CAN-SPAM-compliant marketing emails must have:
  // physical mailing address + one-click unsubscribe.
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F6F3EE;font-family:-apple-system,Segoe UI,sans-serif;color:#1A1A2E;">
  <div style="max-width:600px;margin:0 auto;padding:24px;background:#FFFFFF;">
    ${bodyHtml}
  </div>
  <div style="max-width:600px;margin:0 auto;padding:16px 24px 32px;font-size:11px;color:#1A1A2E99;line-height:1.5;">
    <p style="margin:0 0 8px;">${PRACTICE_NAME} · 5960 Fairview Rd Suite 400, Charlotte, NC 28210</p>
    <p style="margin:0;">Not interested in marketing emails? <a href="${unsubUrl}" style="color:#1A1A2E99;">Unsubscribe here</a>. You'll still get appointment reminders, statements, and other transactional emails.</p>
  </div>
</body></html>`
}

async function sendOne(to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_API_KEY || RESEND_API_KEY === 'PLACEHOLDER') {
    console.log(`[MARKETING SKIPPED — no key] To: ${to} | Subject: ${subject}`)
    return true
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${PRACTICE_NAME} <${FROM_EMAIL}>`, to, subject, html }),
  })
  if (!res.ok) {
    console.error('[marketing] send failed:', await res.text().catch(() => ''))
    return false
  }
  return true
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, name, practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })

  const { subject, html, filters, expected_count } = (req.body ?? {}) as {
    subject?: string; html?: string; filters?: MarketingFilters; expected_count?: number
  }
  if (!subject?.trim()) return res.status(400).json({ error: 'Subject required' })
  if (!html?.trim())    return res.status(400).json({ error: 'Body required' })
  if (!UNSUB_SECRET)    return res.status(500).json({ error: 'MARKETING_UNSUBSCRIBE_SECRET not configured' })

  try { await sql`ALTER TABLE family_profiles ADD COLUMN IF NOT EXISTS marketing_opt_out boolean DEFAULT false` } catch {}
  try { await sql`ALTER TABLE family_profiles ADD COLUMN IF NOT EXISTS marketing_opt_out_at timestamptz` } catch {}
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS marketing_campaigns (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id     uuid NOT NULL,
        subject         text NOT NULL,
        html            text NOT NULL,
        filters         jsonb,
        audience_count  int NOT NULL DEFAULT 0,
        sent_count      int NOT NULL DEFAULT 0,
        failed_count    int NOT NULL DEFAULT 0,
        sent_by_id      uuid,
        sent_by_name    text,
        created_at      timestamptz NOT NULL DEFAULT NOW(),
        completed_at    timestamptz
      )`
  } catch {}

  const audience = await resolveAudience(sql, provider.practice_id, filters ?? {})

  // Safety: if the caller previewed N and the audience count changed by
  // more than ±10% since (someone opted-out, new signups, etc.), bail
  // and ask for a fresh preview. Prevents accidental sends after the
  // biller walked away mid-compose.
  if (expected_count != null) {
    const drift = Math.abs(audience.length - expected_count)
    if (drift > Math.max(5, Math.ceil(expected_count * 0.10))) {
      return res.status(409).json({
        error: `Audience changed from ${expected_count} to ${audience.length}. Preview again before sending.`,
        current_count: audience.length,
      })
    }
  }

  const [campaign] = await sql`
    INSERT INTO marketing_campaigns (practice_id, subject, html, filters, audience_count, sent_by_id, sent_by_name)
    VALUES (${provider.practice_id}::uuid, ${subject}, ${html}, ${JSON.stringify(filters ?? {})}::jsonb,
            ${audience.length}, ${provider.id}::uuid, ${provider.name ?? 'Admin'})
    RETURNING id`
  const campaignId = (campaign as any).id

  let sentCount = 0
  let failedCount = 0

  // Gentle rate limit: 10 messages per second. Resend's standard tier
  // allows 10 req/s on this endpoint, so pace at ~100ms.
  for (const row of audience as any[]) {
    const token = unsubscribeToken(row.id)
    const unsubUrl = `${PORTAL_URL}/api/marketing/unsubscribe?f=${row.id}&t=${token}`
    const wrapped = wrapHtml(html, unsubUrl)
    const ok = await sendOne(row.email, subject, wrapped)
    if (ok) sentCount++
    else failedCount++
    await new Promise(r => setTimeout(r, 100))
  }

  await sql`
    UPDATE marketing_campaigns SET
      sent_count = ${sentCount},
      failed_count = ${failedCount},
      completed_at = NOW()
    WHERE id = ${campaignId}::uuid`

  return res.json({ campaign_id: campaignId, sent: sentCount, failed: failedCount, audience: audience.length })
}
