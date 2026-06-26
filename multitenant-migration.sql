-- Multi-tenancy migration for Roam Platform
-- Run this once in the Neon SQL editor
-- Safe to run on the live database — adds columns and tags existing data

-- ── Step 1: Create practices table ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS practices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text UNIQUE NOT NULL,
  tagline     text,
  about       text,
  logo_url    text,
  city        text,
  state       text,
  phone       text,
  email       text,
  subscription_tier text NOT NULL DEFAULT 'starter',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz DEFAULT now()
);

-- ── Step 2: Insert Pediatric House Calls as the first practice ────────────────

INSERT INTO practices (name, slug, city, state, subscription_tier)
VALUES ('Pediatric House Calls', 'pediatric-house-calls', 'Charlotte', 'NC', 'owner')
ON CONFLICT (slug) DO NOTHING;

-- ── Step 3: Add practice_id to every relevant table ──────────────────────────

ALTER TABLE providers         ADD COLUMN IF NOT EXISTS practice_id uuid REFERENCES practices(id);
ALTER TABLE family_profiles   ADD COLUMN IF NOT EXISTS practice_id uuid REFERENCES practices(id);
ALTER TABLE appointments      ADD COLUMN IF NOT EXISTS practice_id uuid REFERENCES practices(id);
ALTER TABLE broadcasts        ADD COLUMN IF NOT EXISTS practice_id uuid REFERENCES practices(id);
ALTER TABLE booking_requests  ADD COLUMN IF NOT EXISTS practice_id uuid REFERENCES practices(id);
ALTER TABLE waitlist_entries  ADD COLUMN IF NOT EXISTS practice_id uuid REFERENCES practices(id);
ALTER TABLE slot_offers       ADD COLUMN IF NOT EXISTS practice_id uuid REFERENCES practices(id);
ALTER TABLE encounter_notes   ADD COLUMN IF NOT EXISTS practice_id uuid REFERENCES practices(id);
ALTER TABLE claims            ADD COLUMN IF NOT EXISTS practice_id uuid REFERENCES practices(id);
ALTER TABLE children          ADD COLUMN IF NOT EXISTS practice_id uuid REFERENCES practices(id);
ALTER TABLE schedule_blocks   ADD COLUMN IF NOT EXISTS practice_id uuid REFERENCES practices(id);
ALTER TABLE fee_schedule      ADD COLUMN IF NOT EXISTS practice_id uuid REFERENCES practices(id);

-- ── Step 4: Tag all existing data with Pediatric House Calls ─────────────────

UPDATE providers        SET practice_id = (SELECT id FROM practices WHERE slug = 'pediatric-house-calls') WHERE practice_id IS NULL;
UPDATE family_profiles  SET practice_id = (SELECT id FROM practices WHERE slug = 'pediatric-house-calls') WHERE practice_id IS NULL;
UPDATE appointments     SET practice_id = (SELECT id FROM practices WHERE slug = 'pediatric-house-calls') WHERE practice_id IS NULL;
UPDATE broadcasts       SET practice_id = (SELECT id FROM practices WHERE slug = 'pediatric-house-calls') WHERE practice_id IS NULL;
UPDATE booking_requests SET practice_id = (SELECT id FROM practices WHERE slug = 'pediatric-house-calls') WHERE practice_id IS NULL;
UPDATE waitlist_entries SET practice_id = (SELECT id FROM practices WHERE slug = 'pediatric-house-calls') WHERE practice_id IS NULL;
UPDATE slot_offers      SET practice_id = (SELECT id FROM practices WHERE slug = 'pediatric-house-calls') WHERE practice_id IS NULL;
UPDATE encounter_notes  SET practice_id = (SELECT id FROM practices WHERE slug = 'pediatric-house-calls') WHERE practice_id IS NULL;
UPDATE claims           SET practice_id = (SELECT id FROM practices WHERE slug = 'pediatric-house-calls') WHERE practice_id IS NULL;
UPDATE children         SET practice_id = (SELECT id FROM practices WHERE slug = 'pediatric-house-calls') WHERE practice_id IS NULL;
UPDATE schedule_blocks  SET practice_id = (SELECT id FROM practices WHERE slug = 'pediatric-house-calls') WHERE practice_id IS NULL;
UPDATE fee_schedule     SET practice_id = (SELECT id FROM practices WHERE slug = 'pediatric-house-calls') WHERE practice_id IS NULL;

-- ── Step 5: Make practice_id NOT NULL on providers (always set at creation) ───

ALTER TABLE providers ALTER COLUMN practice_id SET NOT NULL;

-- ── Step 6: Add indexes for fast practice-scoped queries ─────────────────────

CREATE INDEX IF NOT EXISTS idx_providers_practice        ON providers(practice_id);
CREATE INDEX IF NOT EXISTS idx_family_profiles_practice  ON family_profiles(practice_id);
CREATE INDEX IF NOT EXISTS idx_appointments_practice     ON appointments(practice_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_practice       ON broadcasts(practice_id);
CREATE INDEX IF NOT EXISTS idx_booking_requests_practice ON booking_requests(practice_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_entries_practice ON waitlist_entries(practice_id);
CREATE INDEX IF NOT EXISTS idx_encounter_notes_practice  ON encounter_notes(practice_id);
CREATE INDEX IF NOT EXISTS idx_claims_practice           ON claims(practice_id);
CREATE INDEX IF NOT EXISTS idx_children_practice         ON children(practice_id);
