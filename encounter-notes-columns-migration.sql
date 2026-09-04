-- Columns added to encounter_notes after initial EMR migration
ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS practice_id uuid;
ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS note_type text;
ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS cpt_codes jsonb NOT NULL DEFAULT '[]';
ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS photos jsonb NOT NULL DEFAULT '[]';
ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS vaccine_administrations jsonb;
ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS iv_administration jsonb;
ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS pcp_faxed_at timestamptz;
ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS pcp_fax_id text;
ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS pcp_faxed_to_name text;

-- Columns added to claims after initial claims migration
ALTER TABLE claims ADD COLUMN IF NOT EXISTS practice_id uuid;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS subscriber_relationship text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS patient_address text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS patient_city text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS patient_state text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS patient_zip text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS encounter_note_id uuid REFERENCES encounter_notes(id);
