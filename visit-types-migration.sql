-- Practice Visit Types Migration
-- Run this in the Neon SQL editor

CREATE TABLE IF NOT EXISTS practice_visit_types (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id             uuid REFERENCES practices(id) NOT NULL,
  visit_type              text NOT NULL,
  base_price              numeric(8,2),
  badge_label             text,
  badge_color             text NOT NULL DEFAULT '#EEEDFE',
  badge_text_color        text NOT NULL DEFAULT '#3C3489',
  duration_minutes        int NOT NULL DEFAULT 60,
  lead_minutes            int NOT NULL DEFAULT 60,
  has_convenience_fee     boolean NOT NULL DEFAULT true,
  per_child_extra_minutes int NOT NULL DEFAULT 0,
  is_in_home              boolean NOT NULL DEFAULT true,
  is_cpr                  boolean NOT NULL DEFAULT false,
  is_active               boolean NOT NULL DEFAULT true,
  sort_order              int NOT NULL DEFAULT 0,
  UNIQUE(practice_id, visit_type)
);

CREATE INDEX IF NOT EXISTS idx_practice_visit_types_practice ON practice_visit_types(practice_id);

-- Seed Pediatric House Calls visit types
INSERT INTO practice_visit_types
  (practice_id, visit_type, base_price, badge_label, badge_color, badge_text_color,
   duration_minutes, lead_minutes, has_convenience_fee, per_child_extra_minutes, is_in_home, is_cpr, sort_order)
SELECT
  p.id,
  v.visit_type, v.base_price::numeric, v.badge_label, v.badge_color, v.badge_text_color,
  v.duration_minutes::int, v.lead_minutes::int, v.has_convenience_fee::boolean,
  v.per_child_extra_minutes::int, v.is_in_home::boolean, v.is_cpr::boolean, v.sort_order::int
FROM practices p
CROSS JOIN (VALUES
  ('In-home sick visit',              150, 'Sick visit',      '#EEEDFE', '#3C3489', 60,  60,  true,  15, true,  false, 1),
  ('Video telemedicine',               75, 'Telemedicine',    '#E1F5EE', '#085041', 30,  30,  false,  0, false, false, 2),
  ('Sports physical',                 125, 'Sports physical', '#FAEEDA', '#633806', 60,  60,  true,  15, true,  false, 3),
  ('CMA + telemedicine',              125, 'CMA + tele',      '#E6F1FB', '#0C447C', 60,  60,  true,  15, true,  false, 4),
  ('Text visit',                       50, 'Text visit',      '#FBEAF0', '#993556', 15,  30,  false,  0, false, false, 5),
  ('In-home IV fluids',               250, 'IV fluids',       '#E1F5EE', '#085041', 90,  60,  true,   0, true,  false, 6),
  ('In-home CPR class (Heartsaver)',   80, 'CPR Heartsaver',  '#FDEDEC', '#922B21', 180, 120, false,  0, true,  true,  7),
  ('In-home CPR class (BLS)',          80, 'CPR BLS',         '#FDEDEC', '#922B21', 180, 120, false,  0, true,  true,  8)
) AS v(visit_type, base_price, badge_label, badge_color, badge_text_color,
       duration_minutes, lead_minutes, has_convenience_fee, per_child_extra_minutes, is_in_home, is_cpr, sort_order)
WHERE p.slug = 'pediatric-house-calls'
ON CONFLICT (practice_id, visit_type) DO NOTHING;
