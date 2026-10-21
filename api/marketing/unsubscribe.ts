import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createHmac, timingSafeEqual } from 'crypto'

const UNSUB_SECRET = process.env.MARKETING_UNSUBSCRIBE_SECRET || process.env.INTERNAL_SERVICE_TOKEN || ''

function expectedToken(familyId: string): string {
  return createHmac('sha256', UNSUB_SECRET).update(familyId).digest('hex').slice(0, 32)
}

function pageHtml(ok: boolean, name?: string): string {
  const title = ok ? 'Unsubscribed' : 'Could not unsubscribe'
  const body = ok
    ? `<p>You've been unsubscribed from marketing emails${name ? `, ${name}` : ''}.</p>
       <p>You'll still receive transactional emails like appointment reminders and billing statements. If you ever change your mind, reach out to us directly.</p>`
    : `<p>This unsubscribe link is invalid or expired. Please reply to the email and we'll remove you by hand.</p>`
  return `<!DOCTYPE html>
<html><head><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="font-family:-apple-system,Segoe UI,sans-serif;background:#F6F3EE;color:#1A1A2E;padding:48px 16px;">
  <div style="max-width:480px;margin:0 auto;background:#FFF;border-radius:12px;padding:32px;">
    <h1 style="font-size:20px;margin:0 0 16px;">${title}</h1>
    ${body}
  </div>
</body></html>`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const familyId = String(req.query.f ?? '')
  const token    = String(req.query.t ?? '')
  res.setHeader('Content-Type', 'text/html; charset=utf-8')

  if (!familyId || !token || !UNSUB_SECRET) {
    return res.status(400).send(pageHtml(false))
  }

  const expected = expectedToken(familyId)
  const a = Buffer.from(token)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(400).send(pageHtml(false))
  }

  const sql = neon(process.env.DATABASE_URL!)
  try { await sql`ALTER TABLE family_profiles ADD COLUMN IF NOT EXISTS marketing_opt_out boolean DEFAULT false` } catch {}
  try { await sql`ALTER TABLE family_profiles ADD COLUMN IF NOT EXISTS marketing_opt_out_at timestamptz` } catch {}

  const [row] = await sql`
    UPDATE family_profiles SET
      marketing_opt_out = true,
      marketing_opt_out_at = NOW()
    WHERE id = ${familyId}::uuid
    RETURNING display_name`
  return res.status(200).send(pageHtml(!!row, row?.display_name))
}
