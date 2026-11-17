// Natural-language ad-hoc report builder. Admin types a question in
// English; we ask Claude Sonnet to translate it into a SELECT query
// against the practice's data; we validate it's read-only and that
// the practice_id scope is intact; we execute; we return results.
//
// Available to every practice. Scoped by the caller's practice_id —
// no cross-practice visibility, ever. Sara 2026-11-16.
//
// POST /api/admin/report-query
//   body: { question: string }
//   → { sql, columns, rows, row_count, warning? } | { error }

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
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

// Compact schema summary passed to Claude. Only the columns we want
// the model to reason over — avoids sending the full DB. Keep this
// focused on practice-level reporting tables.
const SCHEMA_PROMPT = `
You are generating a read-only PostgreSQL SELECT for a per-practice healthcare SaaS.
EVERY query MUST filter by practice_id = '{{PRACTICE_ID}}'::uuid via the first table you join.
Reject the request (return a single line error) if that isn't possible.
Use CTEs freely. No CREATE/DROP/ALTER/INSERT/UPDATE/DELETE/TRUNCATE/GRANT/COPY/MERGE.
One statement only. No semicolons except at the very end (optional).
Date columns are DATE. Timestamps are TIMESTAMPTZ. UUIDs are UUID.

CORE TABLES (practice_id column exists on all of these unless noted):

appointments(id uuid, practice_id uuid, provider_id uuid, child_id uuid, visit_type text,
  scheduled_date date, scheduled_time text, status text ['pending','upcoming','done','cancelled'],
  zone text, notes text, duration_minutes int, created_at timestamptz)

children(id uuid, practice_id uuid, family_id uuid, first_name text, last_name text,
  date_of_birth date, gender text, parent_phone text, parent_email text,
  parent_address text, parent_city text, parent_state text, parent_zip text,
  insurance_provider text, insurance_member_id text, pcp text,
  self_pay boolean, is_archived boolean, created_at timestamptz,
  vaccination_status text, preferred_pharmacy text)

patient_profiles(id uuid, practice_id uuid, first_name text, last_name text,
  date_of_birth date, gender text, phone text, email text, address text,
  city text, state text, zip text, archived boolean, created_at timestamptz)

family_profiles(id uuid, practice_id uuid, display_name text, phone text, email text,
  address_line1 text, city text, state text, zip text)

providers(id uuid, practice_id uuid, name text, role text ['MD','PNP','CMA','RN','ADMIN'],
  email text, phone text, is_admin boolean, is_active boolean, states text[])

encounter_notes(id uuid, practice_id uuid, appointment_id uuid, child_id uuid,
  patient_profile_id uuid, provider_id uuid, note_type text, chief_complaint text,
  signed_at timestamptz, cpt_codes jsonb, diagnoses jsonb, after_visit_instructions text,
  created_at timestamptz)

results(id uuid, practice_id uuid, patient_profile_id uuid, child_id uuid, type text ['pathology','lab'],
  received_at timestamptz, specimen_date date, specimen_type text, specimen_site text,
  source_lab text, source_provider text, report_text text,
  status text ['pending_review','signed','acknowledged'],
  signed_at timestamptz, acknowledged_at timestamptz, ack_channel text,
  diagnosis_id uuid, diagnosis_label text, plan text,
  signed_by_provider_id uuid, acknowledged_by_provider_id uuid)

result_diagnoses(id uuid, practice_id uuid, resource_type text, label text, short_code text,
  is_active boolean)

claims(id uuid, practice_id uuid, child_id uuid, appointment_id uuid,
  patient_first_name text, patient_last_name text, patient_dob date,
  service_date date, cpt_codes jsonb, diagnoses jsonb, payer_name text, payer_id text,
  status text, total_charge numeric, submitted_at timestamptz, era_received_at timestamptz,
  amount_billed_era numeric, insurance_payment_era numeric,
  contractual_adjustment_era numeric, patient_copay_era numeric,
  patient_deductible_era numeric, patient_coinsurance_era numeric,
  patient_non_covered_era numeric, created_at timestamptz)

patient_statements(id uuid, practice_id uuid, claim_id uuid,
  patient_first_name text, patient_last_name text, date_of_service date,
  amount_billed numeric, insurance_payment numeric, contractual_adjustment numeric,
  patient_copay numeric, patient_deductible numeric, patient_coinsurance numeric,
  patient_non_covered numeric, remaining_balance numeric, total_amount_due numeric,
  status text ['draft','sent','paid','partially_paid','written_off','voided'],
  sent_at timestamptz, paid_at timestamptz, paid_amount_cents int, voided_at timestamptz,
  created_at timestamptz)

fee_schedule(practice_id uuid, code text, description text, category text,
  charge_amount numeric, place_of_service text, is_active boolean)

lab_orders(id uuid, practice_id uuid, child_id uuid, created_at timestamptz,
  tests jsonb, icd10_codes text[], status text)

radiology_orders(id uuid, practice_id uuid, child_id uuid, created_at timestamptz,
  modality text, body_part text, status text)

waitlist_entries(id uuid, practice_id uuid, family_id uuid, state text, zip text,
  visit_type text, preferred_time_window text, status text, created_at timestamptz)

chronic_problems(id uuid, practice_id uuid, child_id uuid, patient_profile_id uuid,
  problem text, icd10_code text, resolved_at timestamptz, created_at timestamptz)

RULES RECAP:
- SELECT only. Single statement.
- MUST include practice_id = '{{PRACTICE_ID}}'::uuid as a filter.
- Prefer COALESCE((SELECT first_name||' '||last_name FROM patient_profiles WHERE id = r.patient_profile_id),
  (SELECT first_name||' '||last_name FROM children WHERE id = r.child_id)) when you need a patient name on a row that could be either model.
- Return the raw SQL ONLY — no markdown, no prose, no commentary.
- Reasonable default: LIMIT 500 on open-ended queries; omit LIMIT when the user asked for totals or aggregates.
`

function stripSqlFence(s: string): string {
  // Model sometimes wraps in ```sql ... ``` or ``` ... ```. Strip.
  const m = s.match(/```(?:sql)?\s*([\s\S]*?)```/)
  return (m ? m[1] : s).trim().replace(/;$/, '').trim()
}

const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|COPY|MERGE|CALL|DO|EXECUTE|VACUUM|ANALYZE|CLUSTER|REINDEX|LISTEN|NOTIFY|LOCK|SET|RESET|SHOW|EXPLAIN)\b/i

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, name, practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })
  const practiceId = provider.practice_id as string

  const body = (req.body ?? {}) as Record<string, any>
  const question = String(body.question ?? '').trim()
  if (!question) return res.status(400).json({ error: 'question required' })
  if (question.length > 2000) return res.status(400).json({ error: 'question too long (max 2000 chars)' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' })

  // Ask Claude to translate. Low max_tokens — we only want SQL.
  const systemPrompt = SCHEMA_PROMPT.replace(/\{\{PRACTICE_ID\}\}/g, practiceId)
  let modelSql: string
  try {
    const res2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: question }],
      }),
    })
    if (!res2.ok) {
      const msg = await res2.text()
      return res.status(502).json({ error: `Claude call failed ${res2.status}: ${msg.slice(0, 300)}` })
    }
    const data = await res2.json() as { content?: Array<{ type: string; text?: string }> }
    const text = (data.content ?? []).find(c => c.type === 'text')?.text ?? ''
    modelSql = stripSqlFence(text)
  } catch (e: any) {
    return res.status(502).json({ error: 'Claude unreachable: ' + (e?.message ?? String(e)) })
  }

  if (!modelSql) return res.status(502).json({ error: 'Claude returned no SQL' })

  // Validation — keep it strict.
  if (FORBIDDEN.test(modelSql)) {
    return res.status(400).json({ error: 'Generated SQL contains a disallowed keyword. Rephrase the question.', sql: modelSql })
  }
  if (!/^\s*(WITH|SELECT)\b/i.test(modelSql)) {
    return res.status(400).json({ error: 'Generated SQL did not start with SELECT or WITH.', sql: modelSql })
  }
  // Must reference the caller's practice_id — hard-fail on cross-practice attempts.
  if (!modelSql.includes(practiceId)) {
    return res.status(400).json({ error: 'Generated SQL did not include this practice_id. Refusing to execute.', sql: modelSql })
  }
  // Allow at most one terminating semicolon.
  if ((modelSql.match(/;/g) ?? []).length > 0) {
    return res.status(400).json({ error: 'Generated SQL had intermediate semicolons. Refusing to execute.', sql: modelSql })
  }

  // Set a statement timeout for this one call via the Neon HTTP driver
  // isn't supported, so we instead rely on Vercel's function timeout.
  try {
    const rows = await sql(modelSql as any)
    const columns = rows.length > 0 ? Object.keys(rows[0] as any) : []
    return res.status(200).json({
      sql: modelSql,
      columns,
      rows,
      row_count: rows.length,
    })
  } catch (e: any) {
    return res.status(400).json({
      sql: modelSql,
      error: 'Query execution failed: ' + (e?.message ?? String(e)),
    })
  }
}
