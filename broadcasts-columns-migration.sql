-- Backfill the broadcasts columns that production already has but no
-- migration file added. Without this file, a fresh migration run
-- against a new DB would create a broadcasts table missing the columns
-- api/broadcasts/index.ts writes to (family_phone, family_email,
-- related_appointment_id, pairing_initiator_id, pairing_initiator_name,
-- pairing_role_needed, scheduled_date, scheduled_time), causing the
-- INSERT to fail on every broadcast creation.
--
-- Every column uses IF NOT EXISTS so this is a no-op on production
-- where they already exist.

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS family_phone            text;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS family_email            text;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS related_appointment_id  uuid REFERENCES appointments(id) ON DELETE SET NULL;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS pairing_initiator_id    uuid REFERENCES providers(id) ON DELETE SET NULL;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS pairing_initiator_name  text;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS pairing_role_needed     text;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS scheduled_date          date;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS scheduled_time          text;
