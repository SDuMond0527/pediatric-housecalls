import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

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

// ── X12 277 Claim Acknowledgment parser ──────────────────────────────
// A 277 CA carries:
//   BHT — beginning of hierarchical transaction
//   HL  — hierarchical loops (payer, provider, patient)
//   NM1 — names inside each loop
//   TRN — trace/reference numbers (our PCN echoed back sits in TRN
//         inside the patient loop as TRN*2*<pcn>)
//   STC — claim status. Fields:
//         STC01: composite CATEGORY`STATUSCODE`ENTITY (backtick-separated)
//         STC02: date
//         STC03: action code (WQ = accept, U = reject)
//         STC04: total charge
//         STC05: total paid (only on payment 277P)
//         ...
//         STC12: free-text status message (payer-specific SmartEdits reasons here)
//   DTP — date/period (service dates)
//   REF — additional reference (payer claim control number lives here
//         when the payer has one, in REF*1K)
//
// Status category codes we care about:
//   A1 = Acknowledgement/Receipt (Stedi's "we got it and forwarded") — NOT a rejection
//   A2 = Acknowledgement/Acceptance into adjudication — good
//   A3 = Acknowledgement/Returned as unprocessable claim — REJECTION (Olive's case)
//   A4 = Acknowledgement/Not found — REJECTION
//   A6 = Acknowledgement/Rejected for missing info — REJECTION
//   A7 = Acknowledgement/Rejected for invalid info — REJECTION
//   A8 = Acknowledgement/Rejected for relational field — REJECTION
const REJECTION_CATEGORIES = new Set(['A3', 'A4', 'A6', 'A7', 'A8'])

type ParsedStatus = {
  category:  string   // e.g. 'A3'
  code:      string   // e.g. '21' (status code — "Missing or invalid information")
  entity:    string   // e.g. 'PR' (payer)
  action:    string   // e.g. 'U' (reject) or 'WQ' (working)
  date:      string   // yyyy-mm-dd if parseable
  amount:    number   // total charge / paid for this status
  message:   string   // free-text SmartEdits reason
}

type Parsed277 = {
  patientControlNumber: string | null   // our PCN echoed back
  payerClaimControlNumber: string | null
  patientFirstName: string | null
  patientLastName: string | null
  serviceDateFrom: string | null        // yyyy-mm-dd
  serviceDateTo:   string | null
  payerName: string | null
  transactionSetIdentifier: string | null   // '277' if this is a 277
  statuses: ParsedStatus[]
  isRejection: boolean                  // any status in REJECTION_CATEGORIES
}

function parseX12_277(text: string): Parsed277 {
  const out: Parsed277 = {
    patientControlNumber: null,
    payerClaimControlNumber: null,
    patientFirstName: null,
    patientLastName: null,
    serviceDateFrom: null,
    serviceDateTo: null,
    payerName: null,
    transactionSetIdentifier: null,
    statuses: [],
    isRejection: false,
  }
  if (!text || typeof text !== 'string') return out

  const segments = text
    .replace(/[\r\n]+/g, '')
    .split('~')
    .map(s => s.trim())
    .filter(Boolean)

  // Track hierarchical context — we need to know when NM1/TRN/STC fall
  // inside the patient (HL04 = 'PT' or the terminal HL) vs. provider vs.
  // payer, because the PCN we sent is in TRN inside the patient loop.
  let currentHLLevel: string | null = null

  for (const seg of segments) {
    const fields = seg.split('*')
    const tag = fields[0]

    if (tag === 'ST') {
      // ST*277*0001*005010X214
      out.transactionSetIdentifier = String(fields[1] ?? '').trim() || null
      continue
    }
    if (tag === 'HL') {
      // HL*id*parent*level_code*has_child
      // level codes: 20=payer, 21=info source, 19=provider, PT=patient, 22=subscriber
      currentHLLevel = String(fields[3] ?? '').trim() || null
      continue
    }
    if (tag === 'NM1') {
      // NM1*entity_id*type*last_name*first_name*middle*...*id_qualifier*id_value
      const entity = String(fields[1] ?? '').trim()
      if (entity === 'QC' /* patient */ || (currentHLLevel === 'PT' && entity === 'QC')) {
        out.patientLastName  = out.patientLastName  ?? (String(fields[3] ?? '').trim() || null)
        out.patientFirstName = out.patientFirstName ?? (String(fields[4] ?? '').trim() || null)
      }
      if (entity === 'PR' /* payer */) {
        out.payerName = out.payerName ?? (String(fields[3] ?? '').trim() || null)
      }
      continue
    }
    if (tag === 'TRN' && currentHLLevel === 'PT') {
      // TRN*2*<pcn> inside patient loop = our echoed patient control #
      const v = String(fields[2] ?? '').trim()
      if (v && v !== '0' && !out.patientControlNumber) out.patientControlNumber = v
      continue
    }
    if (tag === 'REF') {
      // REF*1K*<payer claim control number>
      if (String(fields[1] ?? '').trim() === '1K') {
        out.payerClaimControlNumber = String(fields[2] ?? '').trim() || null
      }
      continue
    }
    if (tag === 'DTP') {
      // DTP*472*RD8*20260903-20260903  (service date range)
      if (String(fields[1] ?? '').trim() === '472') {
        const raw = String(fields[3] ?? '').trim()
        const parts = raw.split('-')
        const iso = (yyyymmdd: string) => yyyymmdd?.length === 8
          ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
          : null
        out.serviceDateFrom = iso(parts[0])
        out.serviceDateTo   = iso(parts[1] ?? parts[0])
      }
      continue
    }
    if (tag === 'STC') {
      // STC01 is a composite separated by backticks OR colons depending
      // on the ISA subelement separator (usually `). Parse both.
      const composite = String(fields[1] ?? '')
      const parts = composite.split(/[`:]/)
      const category = String(parts[0] ?? '').trim()
      const code     = String(parts[1] ?? '').trim()
      const entity   = String(parts[2] ?? '').trim()

      const dateStr = String(fields[2] ?? '').trim()
      const action  = String(fields[3] ?? '').trim()
      const amount  = parseFloat(String(fields[4] ?? '0')) || 0

      // Free-text message can live in STC12 or later fields, or in the
      // trailing pipe segments. Grab everything from field 12 onward and
      // stitch — SmartEdits payer messages get dumped here.
      const messageParts: string[] = []
      for (let i = 12; i < fields.length; i++) {
        const p = String(fields[i] ?? '').trim()
        if (p) messageParts.push(p)
      }
      const message = messageParts.join(' ').trim()

      out.statuses.push({ category, code, entity, action, date: dateStr, amount, message })
      if (REJECTION_CATEGORIES.has(category)) out.isRejection = true
      continue
    }
  }

  return out
}

/**
 * POST /api/admin/attach-277-x12
 *
 * Body: { claim_id: string, x12_text: string }
 *
 * Parses a pasted 277 Claim Acknowledgment X12 payload and attaches it
 * to the specified claim. Used to retroactively bring in rejections
 * that arrived before the webhook was set up to process 277s (Olive
 * Dings 2026-09-14: UHC rejected via 277 with SmartEdits for bundling
 * + missing DME modifier; we were silently discarding all non-835
 * webhook events at the time so it never landed).
 *
 * Future 277s auto-attach via the webhook — this endpoint is for the
 * one-off manual fix path.
 *
 * Response includes the parsed rejection so the caller can display
 * what was recorded.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT id, name, is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider?.is_admin) return res.status(403).json({ error: 'Admin access required' })

    const { claim_id, x12_text } = req.body ?? {}
    if (!claim_id || typeof claim_id !== 'string')  return res.status(400).json({ error: 'claim_id (string) required' })
    if (!x12_text || typeof x12_text !== 'string')  return res.status(400).json({ error: 'x12_text (string) required' })

    // Bootstrap the rejection columns on every write path per the
    // "bootstrap on every read path" rule. The claims GET endpoint
    // does the same, so a card can render the badge/banner even if
    // no 277 has ever been attached yet.
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_at timestamptz` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_response jsonb` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_reasons jsonb` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_seen_at timestamptz` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_handled_at timestamptz` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_handled_by_name text` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_handling_notes text` } catch {}

    const parsed = parseX12_277(x12_text)

    if (parsed.transactionSetIdentifier && parsed.transactionSetIdentifier !== '277') {
      return res.status(400).json({ error: `Pasted X12 is a ${parsed.transactionSetIdentifier}, not a 277.` })
    }
    if (parsed.statuses.length === 0) {
      return res.status(400).json({ error: 'No STC status segments found — this does not look like a valid 277 CA.' })
    }
    if (!parsed.isRejection) {
      return res.status(400).json({
        error: 'This 277 is an acknowledgement (not a rejection). Only rejection-type 277s (A3/A4/A6/A7/A8) get attached as rejections.',
        statuses: parsed.statuses.map(s => ({ category: s.category, code: s.code })),
      })
    }

    const [existing] = await sql`
      SELECT id, patient_first_name, patient_last_name
      FROM claims
      WHERE id = ${claim_id}::uuid AND practice_id = ${provider.practice_id}::uuid
      LIMIT 1
    `
    if (!existing) return res.status(404).json({ error: 'Claim not found' })

    // Attach the rejection: full parsed payload for audit, plus a
    // condensed reasons array the UI can render as red banner bullets.
    const reasons = parsed.statuses
      .filter(s => REJECTION_CATEGORIES.has(s.category))
      .map(s => ({
        category: s.category,
        code: s.code,
        entity: s.entity,
        action: s.action,
        amount: s.amount,
        message: s.message,
      }))

    const [updated] = await sql`
      UPDATE claims SET
        claim_rejection_at         = COALESCE(claim_rejection_at, NOW()),
        claim_rejection_response   = ${JSON.stringify(parsed)}::jsonb,
        claim_rejection_reasons    = ${JSON.stringify(reasons)}::jsonb,
        updated_at                 = NOW()
      WHERE id = ${claim_id}::uuid AND practice_id = ${provider.practice_id}::uuid
      RETURNING id
    `

    return res.status(200).json({
      ok: true,
      claim_id: updated?.id,
      parsed: {
        patientControlNumber:    parsed.patientControlNumber,
        payerClaimControlNumber: parsed.payerClaimControlNumber,
        patientFirstName:        parsed.patientFirstName,
        patientLastName:         parsed.patientLastName,
        serviceDateFrom:         parsed.serviceDateFrom,
        serviceDateTo:           parsed.serviceDateTo,
        payerName:               parsed.payerName,
        reasons,
      },
    })
  } catch (e: any) {
    console.error('attach-277-x12 error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
