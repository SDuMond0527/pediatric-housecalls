-- Add child_id to appointments table
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS child_id uuid REFERENCES children(id) ON DELETE SET NULL;

-- Backfill child_id from existing encounter notes
UPDATE appointments a
SET child_id = en.child_id
FROM encounter_notes en
WHERE en.appointment_id = a.id
  AND en.child_id IS NOT NULL
  AND a.child_id IS NULL;
