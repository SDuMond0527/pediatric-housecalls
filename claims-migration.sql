CREATE TABLE IF NOT EXISTS claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_note_id uuid REFERENCES encounter_notes(id),
  appointment_id uuid,
  child_id uuid,
  provider_id uuid,

  -- Insurance snapshot at time of generation
  payer_name text,
  payer_id text,
  subscriber_name text,
  subscriber_dob date,
  subscriber_gender text,
  member_id text,
  group_number text,

  -- Service info
  service_date date,
  place_of_service text DEFAULT '12',
  diagnoses jsonb DEFAULT '[]',
  cpt_codes jsonb DEFAULT '[]',
  total_charge numeric(10,2),

  -- Provider snapshot
  rendering_provider_name text,
  rendering_provider_npi text,
  rendering_provider_taxonomy text,

  -- Patient snapshot
  patient_first_name text,
  patient_last_name text,
  patient_dob date,
  patient_gender text,

  -- Status tracking
  status text NOT NULL DEFAULT 'pending_review',
  stedi_claim_id text,
  stedi_response jsonb,
  submission_error text,
  submitted_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claims_status_idx ON claims(status);
CREATE INDEX IF NOT EXISTS claims_encounter_note_idx ON claims(encounter_note_id);
CREATE INDEX IF NOT EXISTS claims_child_idx ON claims(child_id);
