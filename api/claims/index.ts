import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

// PAYER_IDS inlined to avoid ANY cross-file imports inside api/ —
// Vercel's serverless bundling has repeatedly bitten us on those (see
// memory feedback_verify_after_every_push.md). If you add a payer, also
// update: api/lib/payerIds.ts, api/lib/generateClaim.ts,
// api/encounter-notes/[id].ts.
const PAYER_IDS: Record<string, string> = {
  'self pay': 'PP', 'self-pay': 'PP', 'selfpay': 'PP', 'self': 'PP',
  'bcbs': 'UPICO', 'bcbs of nc': 'UPICO', 'bcbs nc': 'UPICO',
  'blue cross': 'UPICO', 'blue cross nc': 'UPICO',
  'blue cross blue shield': 'UPICO', 'blue cross blue shield of nc': 'UPICO',
  'blue cross blue shield nc': 'UPICO',
  'aetna': '60054', 'cigna': '62308',
  'united healthcare': '87726', 'united health care': '87726', 'uhc': '87726',
  'umr': '39026', 'humana': '61101',
  'phcs': '52133', 'multiplan': '52133',
  'coventry': '38217', 'select health': '53589',
  'medcost': '56162', 'healthgram': '56162',
  'bright health': '98798', 'bright healthcare': '98798',
}
function resolvePayer(name: string | null): string | null {
  if (!name) return null
  const normalized = name.toLowerCase().trim()
  // Anthem routing per Sara 2026-10-05: Virginia Anthem has its own
  // payer ID (VABLS); every other Anthem variant routes to BCBS of NC
  // (UPICO). Check VA FIRST so "Anthem Blue Cross Blue Shield of VA"
  // doesn't fall into the generic Anthem bucket. See
  // project_anthem_payer_id_normalization.md.
  if (/anthem/.test(normalized)) {
    if (/\b(va|virginia)\b/.test(normalized)) return 'VABLS'
    return 'UPICO'
  }
  return PAYER_IDS[normalized] ?? null
}

async function generateClaim(sql: any, encounterNoteId: string, practiceId: string) {
  const [existing] = await sql`
    SELECT id FROM claims WHERE encounter_note_id = ${encounterNoteId}::uuid AND practice_id = ${practiceId}::uuid
  `
  if (existing) return { skipped: 'Claim already exists' }

  const [note] = await sql`SELECT * FROM encounter_notes WHERE id = ${encounterNoteId}::uuid AND practice_id = ${practiceId}::uuid`
  if (!note) return { error: 'Note not found' }
  if (!note.is_signed) return { error: 'Note must be signed' }

  const [appt] = note.appointment_id
    ? await sql`SELECT * FROM appointments WHERE id = ${note.appointment_id}::uuid AND practice_id = ${practiceId}::uuid`
    : [null]
  const resolvedChildId = note.child_id ?? appt?.child_id ?? null
  const [child] = resolvedChildId
    ? await sql`SELECT * FROM children WHERE id = ${resolvedChildId}::uuid AND practice_id = ${practiceId}::uuid`
    : [null]
  const [provider] = note.provider_id
    ? await sql`SELECT name, npi, taxonomy_code FROM providers WHERE id = ${note.provider_id}::uuid AND practice_id = ${practiceId}::uuid`
    : [null]
  const [family] = child?.family_id
    ? await sql`SELECT address_line1, city, state, zip FROM family_profiles WHERE id = ${child.family_id}::uuid AND practice_id = ${practiceId}::uuid`
    : [null]
  // Resolve address across all sources at snapshot time (family_profiles
  // first, fallback to children.parent_* — Carson Yates 2026-09-11 had
  // address on children.parent_address but not on family_profiles).
  const resolvedAddr = {
    line1: family?.address_line1 ?? child?.parent_address ?? null,
    city:  family?.city          ?? child?.parent_city    ?? null,
    state: family?.state         ?? child?.parent_state   ?? null,
    zip:   family?.zip           ?? child?.parent_zip     ?? null,
  }

  // Vaccine encounters are always billed under Dr. Sara DuMond as the
  // rendering provider (see api/lib/generateClaim.ts for the same rule).
  const isVaccineVisit = appt?.visit_type === 'In-home vaccine administration'
  const [supervisingMd] = isVaccineVisit
    ? await sql`SELECT name, npi, taxonomy_code FROM providers WHERE name = 'Dr. Sara DuMond' AND practice_id = ${practiceId}::uuid LIMIT 1`
    : [null]
  const renderingProvider = supervisingMd ?? provider

  const allCptCodes = Array.isArray(note.cpt_codes) ? note.cpt_codes : []
  // Include all codes on the claim (convenience fees show for admin review).
  // Non-Covered Services are stripped from the Stedi payload at submission time.
  const cptCodes = allCptCodes
  const total = cptCodes.reduce((s: number, c: any) => s + (parseFloat(c.charge_amount) || 0), 0)
  const insuranceCodes = allCptCodes.filter((c: any) => c.category !== 'Non-Covered Services')
  // If every CPT on the note is Non-Covered Services (Text e-visit,
  // CPR class, etc.), there is nothing insurance would pay — force
  // self-pay so the biller gets a "Generate patient statement" button
  // instead of "Submit to insurance" for a claim that would only be
  // rejected. Family's insurance-on-file is irrelevant here.
  const forceSelfPay = allCptCodes.length > 0 && insuranceCodes.length === 0
  const pos = insuranceCodes[0]?.place_of_service ?? (appt?.visit_type?.toLowerCase().includes('tele') ? '10' : '12')
  const payerName = forceSelfPay ? 'Self Pay' : (child?.insurance_provider ?? null)
  const payerId   = forceSelfPay ? 'PP'       : resolvePayer(child?.insurance_provider ?? null)

  const [claim] = await sql`
    INSERT INTO claims (
      practice_id, encounter_note_id, appointment_id, child_id, provider_id,
      payer_name, payer_id,
      subscriber_name, subscriber_dob, subscriber_gender, subscriber_relationship, member_id, group_number, insurance_dependent_code,
      service_date, place_of_service,
      diagnoses, cpt_codes, total_charge,
      rendering_provider_name, rendering_provider_npi, rendering_provider_taxonomy,
      patient_first_name, patient_last_name, patient_dob, patient_gender,
      patient_address, patient_city, patient_state, patient_zip
    ) VALUES (
      ${practiceId}::uuid, ${encounterNoteId}::uuid,
      ${note.appointment_id ?? null}::uuid, ${resolvedChildId}::uuid, ${note.provider_id ?? null}::uuid,
      ${payerName}, ${payerId},
      ${child?.insurance_subscriber_name ?? null}, ${child?.insurance_subscriber_dob ?? null},
      ${child?.insurance_subscriber_gender ?? null}, ${child?.insurance_subscriber_relationship ?? null},
      ${child?.insurance_member_id ?? null},
      ${child?.insurance_group_number ?? null},
      ${child?.insurance_dependent_code ?? null},
      ${appt?.scheduled_date ?? null}, ${pos},
      ${JSON.stringify(note.diagnoses ?? [])}::jsonb, ${JSON.stringify(cptCodes)}::jsonb, ${total},
      ${renderingProvider?.name ?? null}, ${renderingProvider?.npi ?? null}, ${renderingProvider?.taxonomy_code ?? null},
      ${child?.first_name ?? null}, ${child?.last_name ?? null},
      ${child?.date_of_birth ?? null}, ${child?.gender ?? null},
      ${resolvedAddr.line1}, ${resolvedAddr.city}, ${resolvedAddr.state}, ${resolvedAddr.zip}
    )
    RETURNING *`

  return { claim }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const sql = neon(process.env.DATABASE_URL!)

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  // GET — list claims
  if (req.method === 'GET') {
    try {
      // Bootstrap reopen columns on the read path — the rendered card
      // reads reopened_at / reopen_reason to badge rework claims, so
      // the columns must exist before the first reopen ever happens,
      // per the "bootstrap on every read path" rule.
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopened_at timestamptz` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopened_by uuid` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopen_reason text` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopen_note text` } catch {}
      // Bootstrap 277 rejection columns on the read path — the claim
      // card reads claim_rejection_at + claim_rejection_reasons +
      // claim_rejection_handled_at to render the REJECTED AT INTAKE
      // badge, banner, and mark-handled action.
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_at timestamptz` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_response jsonb` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_reasons jsonb` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_seen_at timestamptz` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_handled_at timestamptz` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_handled_by_name text` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_handling_notes text` } catch {}
      // Pre-submit scrubber reads children.last_eligibility_check_at to
      // warn on stale eligibility. Bootstrap here too so a fresh branch
      // can still SELECT it in the join below without blowing up.
      try { await sql`ALTER TABLE children ADD COLUMN IF NOT EXISTS last_eligibility_check_at timestamptz` } catch {}
      // Rework resolve columns — biller manual "I'm done" signal
      // that pulls the claim out of Rework tab into Completed.
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS rework_resolved_at timestamptz` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS rework_resolved_by uuid` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS rework_resolved_by_name text` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS rework_resolved_note text` } catch {}
      // Short human-readable Patient Control Number sent on the outbound
      // 837 claim. PEDS + 5-digit sequential (e.g., PEDS00042). Assigned
      // at submit time from a Postgres sequence.
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS payer_control_number text` } catch {}
      // Pam's "Convenience Fee Review" tab checkbox — she ticks it after
      // running the Square charge manually, which clears the claim from
      // her queue. Doesn't affect Andrea's Ready for Biller view.
      // DEPRECATED 2026-10-06 — replaced by the dedicated
      // convenience_fee_charges table + /admin/convenience-fees page.
      // Column kept for now so historical data isn't lost; the tab is
      // deleted from AdminClaims in this same commit. Sara 2026-10-06.
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS convenience_fee_handled boolean NOT NULL DEFAULT false` } catch {}

      // Resubmission log — jsonb array of entries, one per Fix+resubmit
      // click from the Rework tab. Shape:
      //   [{ at: iso, by: uuid, by_name: text, note: text|null,
      //      prior_denial_codes: jsonb|null, prior_claim_rejection_at: iso|null }]
      // Bootstrapped here (read path) in addition to the fix-resubmit
      // endpoint so a cold reader can SELECT the column even if the
      // endpoint hasn't been hit yet. Sara 2026-10-06.
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS resubmission_log jsonb DEFAULT '[]'::jsonb` } catch {}

      // Attachments table (bootstrap on every read path per the
      // "bootstrap on every read path" rule — the claims list
      // response doesn't query this table, but the attachments
      // endpoint hangs off every claim card, so an empty cold-start
      // can't 500 on the first attach click).
      try {
        await sql`
          CREATE TABLE IF NOT EXISTS claim_attachments (
            id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            claim_id         uuid NOT NULL,
            practice_id      uuid NOT NULL,
            file_name        text NOT NULL,
            file_url         text NOT NULL,
            mime_type        text,
            size_bytes       bigint,
            note             text,
            uploaded_at      timestamptz NOT NULL DEFAULT NOW(),
            uploaded_by      uuid,
            uploaded_by_name text
          )`
        await sql`CREATE INDEX IF NOT EXISTS claim_attachments_claim_id_idx ON claim_attachments(claim_id)`
      } catch {}

      // Dedicated audit + action table for every convenience fee event.
      // One row per claim with a CV charge. Pam's /admin/convenience-fees
      // page is the single surface where she sees pending / charged /
      // link-sent / failed / reversed CV charges and takes action.
      // Rows get inserted at claim-gen time for appointments with
      // scheduled_date >= 2026-10-07 (automation cutover date). Pre-
      // cutover visits are handled by Pam's existing manual Square
      // workflow and don't produce rows here. Sara 2026-10-06.
      try {
        await sql`
          CREATE TABLE IF NOT EXISTS convenience_fee_charges (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            practice_id     uuid NOT NULL,
            appointment_id  uuid,
            claim_id        uuid,
            patient_name    text,
            provider_name   text,
            service_date    date NOT NULL,
            cv_code         text NOT NULL,
            amount_cents    integer NOT NULL,
            status          text NOT NULL DEFAULT 'pending',
            square_payment_id       text,
            square_payment_link_id  text,
            square_payment_link_url text,
            -- Square creates an order when a payment link is generated.
            -- The paid-via-link webhook matches on this order_id. Also
            -- bootstrapped idempotently so existing deployments pick it up.
            square_order_id         text,
            created_at    timestamptz NOT NULL DEFAULT NOW(),
            charged_at    timestamptz,
            link_sent_at  timestamptz,
            paid_at       timestamptz,
            failed_at     timestamptz,
            reversed_at   timestamptz,
            failure_reason   text,
            reversed_by      text,
            reversal_reason  text,
            pam_notes            text,
            pam_notes_updated_at timestamptz,
            pam_notes_updated_by text,
            updated_at    timestamptz NOT NULL DEFAULT NOW()
          )`
        await sql`CREATE INDEX IF NOT EXISTS cv_charges_service_date_idx ON convenience_fee_charges(service_date DESC)`
        await sql`CREATE INDEX IF NOT EXISTS cv_charges_status_idx       ON convenience_fee_charges(status)`
        await sql`CREATE INDEX IF NOT EXISTS cv_charges_claim_idx        ON convenience_fee_charges(claim_id)`
        // Added 2026-10-06 as part of Phase 2 (Square auto-charge). Existing
        // tables created in Phase 1a bootstrap won't have this column yet.
        await sql`ALTER TABLE convenience_fee_charges ADD COLUMN IF NOT EXISTS square_order_id text`
        await sql`CREATE INDEX IF NOT EXISTS cv_charges_square_order_idx  ON convenience_fee_charges(square_order_id)`
      } catch {}
      const { status, era_count } = req.query as Record<string, string>

      // Biller work queue: Pending Review + Rework + Submitted (waiting on
      // payer). Explicitly EXCLUDES anything that has moved to Pam's
      // queue — a draft statement means Andrea's done, Pam reviews and
      // sends it. Also excludes anything terminal (written off, rework
      // resolved, ERA back on a submitted claim all live on the
      // Completed tab, which is the hand-off to Pam). Also excludes
      // pending_provider_response (ball is with the provider, not
      // Andrea). Mirrors the sum of the Pending Review + Rework +
      // Submitted tab counts on AdminClaims. Sara 2026-10-01.
      if (era_count === '1') {
        const [row] = await sql`
          SELECT COUNT(*)::int AS count
          FROM claims cl
          WHERE cl.practice_id = ${practiceId}::uuid
            AND cl.status != 'written_off'
            AND cl.status != 'pending_provider_response'
            AND cl.rework_resolved_at IS NULL
            AND NOT (cl.status = 'submitted' AND cl.era_received_at IS NOT NULL)
            AND NOT EXISTS (
              SELECT 1 FROM patient_statements ps
              WHERE ps.claim_id = cl.id
                AND ps.status IN ('draft', 'sent', 'paid')
            )`
        return res.json({ count: row?.count ?? 0 })
      }
      const rows = status
        ? await sql`
            SELECT cl.*, COALESCE(cl.child_id, a.child_id) AS effective_child_id,
              c.first_name AS child_first_name, c.last_name AS child_last_name,
              c.chart_number AS chart_number,
              c.last_eligibility_check_at AS last_eligibility_check_at,
              fp.email AS family_email,
              COALESCE(fp.phone, c.parent_phone) AS family_phone,
              ps.status AS statement_status, ps.sent_at AS statement_sent_at,
              -- Doc-attachment count surfaced on each card so the biller
              -- can see at a glance whether this claim has supporting
              -- docs stored (payer-portal re-upload, audit trail, etc.).
              -- Full list is fetched via /api/claims/[id]/attachments
              -- when the card expands. Sara 2026-10-06.
              COALESCE(att.attachment_count, 0) AS attachment_count
            FROM claims cl
            LEFT JOIN appointments a ON a.id = cl.appointment_id
            LEFT JOIN children c ON c.id = COALESCE(cl.child_id, a.child_id)
            LEFT JOIN family_profiles fp ON fp.id = c.family_id
            LEFT JOIN patient_statements ps ON ps.claim_id = cl.id
            LEFT JOIN (
              SELECT claim_id, COUNT(*)::int AS attachment_count
              FROM claim_attachments
              GROUP BY claim_id
            ) att ON att.claim_id = cl.id
            WHERE cl.status = ${status} AND cl.practice_id = ${practiceId}::uuid
            ORDER BY cl.created_at DESC`
        : await sql`
            SELECT cl.*, COALESCE(cl.child_id, a.child_id) AS effective_child_id,
              c.first_name AS child_first_name, c.last_name AS child_last_name,
              c.chart_number AS chart_number,
              c.last_eligibility_check_at AS last_eligibility_check_at,
              fp.email AS family_email,
              COALESCE(fp.phone, c.parent_phone) AS family_phone,
              ps.status AS statement_status, ps.sent_at AS statement_sent_at,
              -- Doc-attachment count surfaced on each card so the biller
              -- can see at a glance whether this claim has supporting
              -- docs stored (payer-portal re-upload, audit trail, etc.).
              -- Full list is fetched via /api/claims/[id]/attachments
              -- when the card expands. Sara 2026-10-06.
              COALESCE(att.attachment_count, 0) AS attachment_count
            FROM claims cl
            LEFT JOIN appointments a ON a.id = cl.appointment_id
            LEFT JOIN children c ON c.id = COALESCE(cl.child_id, a.child_id)
            LEFT JOIN family_profiles fp ON fp.id = c.family_id
            LEFT JOIN patient_statements ps ON ps.claim_id = cl.id
            LEFT JOIN (
              SELECT claim_id, COUNT(*)::int AS attachment_count
              FROM claim_attachments
              GROUP BY claim_id
            ) att ON att.claim_id = cl.id
            WHERE cl.practice_id = ${practiceId}::uuid
            ORDER BY cl.created_at DESC`
      const CLIA_CPT_CODES = new Set(['87880', '87812', '81002', '82962'])
      const PRACTICE_CLIA = process.env.PRACTICE_CLIA_NUMBER || ''
      const annotated = rows.map((r: any) => {
        const needsClia = PRACTICE_CLIA && (r.cpt_codes ?? []).some((c: any) => CLIA_CPT_CODES.has(String(c.code)))
        return { ...r, clia_number: needsClia ? PRACTICE_CLIA : null }
      })
      return res.json(annotated)
    } catch (e: any) {
      console.error('[claims GET] error:', e?.message)
      return res.status(500).json({ error: e?.message ?? 'Failed to load claims' })
    }
  }

  // POST — generate a claim from an encounter note
  if (req.method === 'POST') {
    try {
      const { encounter_note_id } = req.body
      if (!encounter_note_id) return res.status(400).json({ error: 'encounter_note_id required' })
      const result = await generateClaim(sql, encounter_note_id, practiceId)
      if (result.error) return res.status(400).json({ error: result.error })
      if (result.skipped) return res.status(409).json({ error: result.skipped })
      return res.status(201).json(result.claim)
    } catch (e: any) {
      console.error('[claims POST] error:', e?.message, e?.stack)
      return res.status(500).json({ error: e?.message ?? 'Failed to generate claim' })
    }
  }

  res.status(405).json({ error: 'Method not allowed' })
}
