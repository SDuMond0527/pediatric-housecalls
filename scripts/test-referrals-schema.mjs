import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

await sql`
  CREATE TABLE IF NOT EXISTS referrals_in (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    practice_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    referral_type text NOT NULL DEFAULT 'iv_fluids',
    referring_uc_name text NOT NULL,
    referring_provider_name text NOT NULL,
    provider_attestation boolean NOT NULL DEFAULT false,
    patient_first_name text NOT NULL,
    patient_last_name text NOT NULL,
    patient_dob date NOT NULL,
    patient_gender text,
    patient_weight text,
    parent_name text NOT NULL,
    parent_phone text NOT NULL,
    parent_email text NOT NULL,
    parent_address text NOT NULL,
    insurance_provider text,
    insurance_member_id text,
    subscriber_name text,
    subscriber_dob date,
    subscriber_gender text,
    insurance_card_front_url text,
    insurance_card_back_url text,
    iv_intake jsonb,
    status text NOT NULL DEFAULT 'new',
    status_updated_at timestamptz,
    status_updated_by text,
    appointment_id uuid,
    activity_log jsonb NOT NULL DEFAULT '[]'::jsonb
  )`
console.log('table ok')

// Smoke-test the status ordering query the inbox uses
const [practice] = await sql`SELECT id FROM practices LIMIT 1`
const result = await sql`
  SELECT * FROM referrals_in
  WHERE practice_id = ${practice.id}::uuid
  ORDER BY
    CASE status WHEN 'new' THEN 0 WHEN 'contacted' THEN 1 WHEN 'scheduled' THEN 2 WHEN 'declined' THEN 3 WHEN 'closed' THEN 4 ELSE 5 END,
    created_at DESC
  LIMIT 200`
console.log('inbox query ok, rows:', result.length)

// Smoke-test the RN availability query
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const rns = await sql`SELECT id, name FROM providers WHERE practice_id = ${practice.id}::uuid AND role = 'RN' AND is_active = true ORDER BY name`
console.log(`RNs on practice: ${rns.length}`)
if (rns.length > 0) {
  const ids = rns.map(r => r.id)
  const overrides = await sql`
    SELECT provider_id, date::text AS date, is_available, start_time, end_time
    FROM availability_overrides
    WHERE provider_id = ANY(${ids}::uuid[])
      AND date::date IN (${today}::date, ${tomorrow}::date)`
  console.log(`overrides for today(${today}) / tomorrow(${tomorrow}):`, overrides.length)
}

// bootstrap the receives_referral_alerts column referenced in iv-fluids.ts
await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS receives_referral_alerts boolean DEFAULT false`
console.log('receives_referral_alerts column ok')
