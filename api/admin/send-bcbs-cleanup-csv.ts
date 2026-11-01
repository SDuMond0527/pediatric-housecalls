import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const FROM_EMAIL     = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
const PRACTICE_NAME  = process.env.PRACTICE_NAME || 'Pediatric Housecalls'

/**
 * POST /api/admin/send-bcbs-cleanup-csv — service-token-gated.
 * Builds the BCBS cleanup CSV (kids missing a dep code) and emails it
 * to the recipients named in the request body.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const expected = process.env.INTERNAL_SERVICE_TOKEN || ''
  const provided = String(req.headers['x-internal-service-token'] ?? '')
  if (!expected || provided !== expected) return res.status(401).json({ error: 'Unauthorized' })

  const to = Array.isArray((req.body ?? {}).to) ? (req.body as any).to : []
  if (to.length === 0) return res.status(400).json({ error: 'body.to array required' })
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not configured' })

  const sql = neon(process.env.DATABASE_URL!)
  const rows = await sql`
    SELECT first_name, last_name, date_of_birth,
           insurance_provider, insurance_member_id, insurance_dependent_code,
           insurance_subscriber_name,
           LENGTH(insurance_member_id) AS mid_len
    FROM children
    WHERE (insurance_provider ILIKE '%blue%' OR insurance_provider ILIKE '%bcbs%' OR insurance_provider ILIKE '%anthem%')
      AND (insurance_dependent_code IS NULL OR TRIM(insurance_dependent_code) = '')
    ORDER BY insurance_member_id, date_of_birth` as any[]

  // Group by member_id so multi-sibling families cluster together,
  // multi-sibling first (sort by sibling count desc).
  const groups = new Map<string, { member_id: string; mid_len: number; provider: string; subscriber: string; kids: any[] }>()
  for (const r of rows) {
    const key = String(r.insurance_member_id ?? '(no id)').trim()
    if (!groups.has(key)) groups.set(key, {
      member_id: key, mid_len: r.mid_len,
      provider: r.insurance_provider ?? '',
      subscriber: r.insurance_subscriber_name ?? '',
      kids: [],
    })
    groups.get(key)!.kids.push(r)
  }
  const sortedGroups = Array.from(groups.values()).sort((a, b) => b.kids.length - a.kids.length)

  const escapeCsv = (v: any) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const headers = ['Family / member_id', 'Payer', 'Subscriber', 'Patient first', 'Patient last', 'DOB', 'Dep code (fill in)', 'Done?']
  const lines = [headers.join(',')]
  for (const g of sortedGroups) {
    for (const k of g.kids) {
      lines.push([
        `${g.member_id} (${g.mid_len} chars)`,
        g.provider,
        g.subscriber,
        (k.first_name ?? '').trim(),
        (k.last_name ?? '').trim(),
        k.date_of_birth ? new Date(k.date_of_birth).toISOString().slice(0, 10) : '',
        '',
        '',
      ].map(escapeCsv).join(','))
    }
  }
  const csv = lines.join('\n')
  const base64 = Buffer.from(csv, 'utf-8').toString('base64')

  const kidCount = rows.length
  const familyCount = groups.size
  const html = `
    <p>Attached: BCBS cleanup list — ${kidCount} kids across ${familyCount} families missing a 2-digit dependent code.</p>
    <p><strong>What to do:</strong> for each row, call BCBS (or check the physical card) to confirm the dep code suffix for that specific child, enter it in the "Dep code (fill in)" column, and update the chart in GoRoam. Mark "Done?" when complete.</p>
    <p><strong>Why it matters:</strong> without the dep code, claims go to Stedi with a bare 12-char member ID and BCBS treats them as the subscriber instead of the child. Causes silent rejections and incorrect payments.</p>
    <p>Multi-sibling families are listed first — those are higher priority because the same family number is used for every child but with a different suffix per kid.</p>
  `
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${PRACTICE_NAME} <${FROM_EMAIL}>`,
      to,
      subject: `BCBS chart cleanup — ${kidCount} kids missing dependent code`,
      html,
      attachments: [{ filename: 'bcbs-cleanup.csv', content: base64 }],
    }),
  })
  if (!r.ok) {
    const msg = await r.text()
    return res.status(502).json({ error: `Resend rejected send: ${msg.slice(0, 400)}` })
  }
  return res.json({ ok: true, sent_to: to, kid_count: kidCount, family_count: familyCount })
}
