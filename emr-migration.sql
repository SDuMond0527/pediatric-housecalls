CREATE TABLE IF NOT EXISTS encounter_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE NOT NULL UNIQUE,
  child_id uuid REFERENCES children(id) ON DELETE SET NULL,
  provider_id uuid REFERENCES providers(id) ON DELETE SET NULL,
  chief_complaint text,
  subjective text,
  objective text,
  assessment text,
  plan text,
  diagnoses jsonb NOT NULL DEFAULT '[]',
  is_signed boolean NOT NULL DEFAULT false,
  signed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vitals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE NOT NULL UNIQUE,
  child_id uuid REFERENCES children(id) ON DELETE SET NULL,
  temperature_f numeric(4,1),
  heart_rate int,
  respiratory_rate int,
  oxygen_saturation int,
  weight_lbs numeric(5,1),
  height_in numeric(4,1),
  systolic_bp int,
  diastolic_bp int,
  recorded_at timestamptz DEFAULT now()
);
