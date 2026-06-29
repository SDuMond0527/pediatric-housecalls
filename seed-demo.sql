-- ─────────────────────────────────────────────────────────────────────────────
-- Roam Platform — Demo Seed
-- ─────────────────────────────────────────────────────────────────────────────
-- Creates a fictional practice "Crestview Pediatrics" with realistic sample
-- data. Safe to run multiple times — uses fixed UUIDs and ON CONFLICT guards.
--
-- SETUP STEPS AFTER RUNNING THIS SCRIPT:
--
--   1. Note the practice UUID printed by RAISE NOTICE below.
--      Set it as VITE_PRACTICE_ID in your Vercel demo deployment.
--
--   2. Create two Cognito User Pools in AWS (us-east-2 recommended):
--        Pool A — providers/admin  (no client secret; USER_PASSWORD_AUTH + USER_SRP_AUTH)
--        Pool B — families         (same settings)
--
--   3. In Pool A, create two users:
--        demo-admin@tryroam.com     (temporary password: DemoAdmin1!)
--        demo-provider@tryroam.com  (temporary password: DemoProvider1!)
--      In Pool B, create one user:
--        demo-family@tryroam.com    (temporary password: DemoFamily1!)
--      For each user, set "Mark email as verified" and "Don't send invite."
--
--   4. Get the Cognito `sub` for each user (visible in user detail in AWS Console).
--      Then run these three updates:
--        UPDATE providers SET cognito_sub = '<real-sub>'
--          WHERE id = 'de000000-0000-4000-8000-000000000002';
--        UPDATE providers SET cognito_sub = '<real-sub>'
--          WHERE id = 'de000000-0000-4000-8000-000000000003';
--        UPDATE family_profiles SET cognito_sub = '<real-sub>'
--          WHERE id = 'de000000-0000-4000-8000-000000000005';
--
--   5. Create a Vercel project from the roam-platform repo and set env vars:
--        VITE_PRACTICE_ID              = de000000-0000-4000-8000-000000000001
--        VITE_PRACTICE_NAME            = Crestview Pediatrics
--        VITE_PRACTICE_TAGLINE         = Mobile pediatric urgent care · Charlotte, NC
--        VITE_ACCENT_COLOR             = #7F77DD
--        VITE_AWS_REGION               = us-east-2
--        VITE_AWS_USER_POOL_ID         = <Pool A user pool ID>
--        VITE_AWS_CLIENT_ID            = <Pool A app client ID>
--        VITE_FAMILY_USER_POOL_ID      = <Pool B user pool ID>
--        VITE_FAMILY_CLIENT_ID         = <Pool B app client ID>
--        VITE_DEMO_MODE                = true
--        VITE_DEMO_ADMIN_EMAIL         = demo-admin@tryroam.com
--        VITE_DEMO_ADMIN_PASSWORD      = DemoAdmin1!
--        VITE_DEMO_PROVIDER_EMAIL      = demo-provider@tryroam.com
--        VITE_DEMO_PROVIDER_PASSWORD   = DemoProvider1!
--        VITE_DEMO_FAMILY_EMAIL        = demo-family@tryroam.com
--        VITE_DEMO_FAMILY_PASSWORD     = DemoFamily1!
--        DATABASE_URL                  = <Neon connection string>
--        AWS_ADMIN_ACCESS_KEY_ID       = <IAM key with Cognito admin perms>
--        AWS_ADMIN_SECRET_ACCESS_KEY   = <IAM secret>
--        PORTAL_URL                    = https://<your-demo-domain>.vercel.app
--        FROM_EMAIL                    = <verified Resend sender>
--        PRACTICE_NAME                 = Crestview Pediatrics
--        RESEND_API_KEY                = <Resend key>
--        TWILIO_ACCOUNT_SID            = <Twilio sid> (or omit to skip SMS)
--
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  pid          uuid := 'de000000-0000-4000-8000-000000000001';
  admin_id     uuid := 'de000000-0000-4000-8000-000000000002';
  prov_id      uuid := 'de000000-0000-4000-8000-000000000003';
  prov2_id     uuid := 'de000000-0000-4000-8000-000000000004';
  family_id    uuid := 'de000000-0000-4000-8000-000000000005';
  family2_id   uuid := 'de000000-0000-4000-8000-000000000006';
  child1_id    uuid := 'de000000-0000-4000-8000-000000000007';
  child2_id    uuid := 'de000000-0000-4000-8000-000000000008';
  child3_id    uuid := 'de000000-0000-4000-8000-000000000009';
  child4_id    uuid := 'de000000-0000-4000-8000-00000000000a';
BEGIN

-- ── 1. Practice ──────────────────────────────────────────────────────────────
INSERT INTO practices (id, name, slug, tagline, city, state, phone, email, subscription_tier)
VALUES (
  pid,
  'Crestview Pediatrics',
  'crestview-pediatrics',
  'Mobile pediatric urgent care · Charlotte, NC',
  'Charlotte', 'NC',
  '704-555-0100',
  'hello@crestviewpeds.example.com',
  'standard'
)
ON CONFLICT (id) DO NOTHING;

RAISE NOTICE 'Practice ID: %  ← Set this as VITE_PRACTICE_ID in Vercel', pid;

-- ── 2. Visit types ───────────────────────────────────────────────────────────
INSERT INTO practice_visit_types
  (practice_id, visit_type, base_price, badge_label, badge_color, badge_text_color,
   duration_minutes, lead_minutes, has_convenience_fee, per_child_extra_minutes,
   is_in_home, is_cpr, is_active, sort_order)
VALUES
  (pid, 'In-home sick visit',  150, 'Sick visit',     '#EEEDFE', '#3C3489', 60,  60, true,  15, true,  false, true, 1),
  (pid, 'Video telemedicine',   75, 'Telemedicine',   '#E1F5EE', '#085041', 30,  30, false,  0, false, false, true, 2),
  (pid, 'Sports physical',     125, 'Sports physical','#FAEEDA', '#633806', 60,  60, true,  15, true,  false, true, 3),
  (pid, 'Text visit',           50, 'Text visit',     '#FBEAF0', '#993556', 15,  30, false,  0, false, false, true, 4),
  (pid, 'In-home IV fluids',   250, 'IV fluids',      '#E1F5EE', '#085041', 90,  60, true,   0, true,  false, true, 5)
ON CONFLICT (practice_id, visit_type) DO NOTHING;

-- ── 3. Zones ─────────────────────────────────────────────────────────────────
INSERT INTO practice_zones (practice_id, zone_name, state, zips, sort_order)
VALUES
  (pid, 'North Charlotte',    'NC', ARRAY['28078','28036','28031','28269'], 1),
  (pid, 'South Charlotte',    'NC', ARRAY['28226','28270','28277','28173'], 2),
  (pid, 'Downtown / Midtown', 'NC', ARRAY['28203','28204','28205','28207','28209','28210'], 3),
  (pid, 'Matthews / Monroe',  'NC', ARRAY['28104','28105','28106'], 4),
  (pid, 'Fort Mill',          'SC', ARRAY['29708','29715','29716'], 5)
ON CONFLICT (practice_id, zone_name) DO NOTHING;

-- ── 4. Providers ─────────────────────────────────────────────────────────────
-- cognito_sub values are placeholders — replace with real Cognito subs (Step 4 above)

INSERT INTO providers (id, practice_id, cognito_sub, name, role, initials,
  zones, states, avatar_color, avatar_text_color, is_active, is_admin, email, phone)
VALUES
  (admin_id, pid,
   'demo-placeholder-admin-sub',
   'Dr. Sarah Mitchell', 'MD', 'SM',
   ARRAY['North Charlotte','South Charlotte','Downtown / Midtown'], ARRAY['NC','SC'],
   '#FAEEDA', '#633806', true, true,
   'demo-admin@tryroam.com', '704-555-0101'),

  (prov_id, pid,
   'demo-placeholder-provider-sub',
   'Dr. James Carter', 'PNP', 'JC',
   ARRAY['North Charlotte','Matthews / Monroe','Fort Mill'], ARRAY['NC','SC'],
   '#E1F5EE', '#085041', true, false,
   'demo-provider@tryroam.com', '704-555-0102'),

  (prov2_id, pid,
   'demo-placeholder-display-sub',
   'Dr. Emily Torres', 'MD', 'ET',
   ARRAY['South Charlotte','Downtown / Midtown'], ARRAY['NC'],
   '#EEEDFE', '#3C3489', true, false,
   'emily.torres@crestviewpeds.example.com', '704-555-0103')

ON CONFLICT (id) DO NOTHING;

-- ── 5. Availability ──────────────────────────────────────────────────────────
INSERT INTO availability (provider_id, day_of_week, is_active, start_time, end_time)
SELECT admin_id, d, true, '08:00', '17:00' FROM generate_series(1,5) d
ON CONFLICT (provider_id, day_of_week) DO NOTHING;

INSERT INTO availability (provider_id, day_of_week, is_active, start_time, end_time)
SELECT prov_id, d, true, '09:00', '18:00' FROM generate_series(1,6) d
ON CONFLICT (provider_id, day_of_week) DO NOTHING;

INSERT INTO availability (provider_id, day_of_week, is_active, start_time, end_time)
SELECT prov2_id, d, true, '08:00', '16:00' FROM generate_series(1,5) d
ON CONFLICT (provider_id, day_of_week) DO NOTHING;

-- ── 6. Families ──────────────────────────────────────────────────────────────
-- cognito_sub for family_id must be replaced with real Cognito sub (Step 4 above)

INSERT INTO family_profiles (id, practice_id, cognito_sub, email, display_name, phone,
  address_line1, city, state, zip, agreements_accepted_at, payment_policy_accepted_at)
VALUES
  (family_id, pid,
   'demo-placeholder-family-sub',
   'demo-family@tryroam.com', 'The Parker Family', '704-555-0200',
   '1234 Elm Street', 'Charlotte', 'NC', '28078', now(), now()),

  (family2_id, pid,
   'demo-placeholder-family2-sub',
   'rodriguez@tryroam.example.com', 'The Rodriguez Family', '704-555-0201',
   '567 Oak Avenue', 'Charlotte', 'NC', '28226', now(), now())

ON CONFLICT (id) DO NOTHING;

-- ── 7. Children ──────────────────────────────────────────────────────────────
INSERT INTO children (id, family_id, practice_id, display_label, first_name, last_name,
  date_of_birth, gender, allergies, current_medications, medical_history)
VALUES
  (child1_id, family_id, pid, 'Emma', 'Emma', 'Parker',
   '2016-03-14', 'female', 'NKDA', 'None', 'Mild seasonal allergies'),
  (child2_id, family_id, pid, 'Oliver', 'Oliver', 'Parker',
   '2019-08-22', 'male', 'Penicillin', 'None', 'History of recurrent otitis media'),
  (child3_id, family2_id, pid, 'Sofia', 'Sofia', 'Rodriguez',
   '2021-05-10', 'female', 'NKDA', 'None', ''),
  (child4_id, family2_id, pid, 'Marco', 'Marco', 'Rodriguez',
   '2023-01-30', 'male', 'NKDA', 'None', '')
ON CONFLICT (id) DO NOTHING;

-- ── 8. Recent past appointments (last 2 weeks, status: done) ─────────────────
-- Skipped if any past appointments already exist for this practice.
IF NOT EXISTS (
  SELECT 1 FROM appointments
  WHERE practice_id = pid AND scheduled_date BETWEEN CURRENT_DATE - 14 AND CURRENT_DATE - 1
  LIMIT 1
) THEN
  INSERT INTO appointments (practice_id, provider_id, visit_type, zone,
    scheduled_time, scheduled_date, status, notes, duration_minutes)
  VALUES
    (pid, admin_id,    'In-home sick visit',  'North Charlotte',    '09:00', CURRENT_DATE - 14, 'done',
     'CC: fever 102.4°F ×2d, congestion. Dx: viral URI. Plan: supportive care, fluids.', 60),
    (pid, admin_id,    'In-home sick visit',  'South Charlotte',    '11:00', CURRENT_DATE - 13, 'done',
     'CC: ear pain, pulling at ear. Dx: acute otitis media R. Plan: amoxicillin ×10d.', 60),
    (pid, prov_id, 'Video telemedicine',  'North Charlotte',    '10:00', CURRENT_DATE - 12, 'done',
     'CC: truncal rash ×3d. Dx: viral exanthem (roseola). Plan: symptomatic.', 30),
    (pid, prov2_id,'Sports physical',     'South Charlotte',    '14:00', CURRENT_DATE - 11, 'done',
     'Annual sports physical. All systems WNL. Cleared for all sports.', 60),
    (pid, admin_id,    'In-home sick visit',  'Downtown / Midtown', '08:30', CURRENT_DATE - 10, 'done',
     'CC: vomiting ×12h, diarrhea. Dx: acute gastroenteritis. Plan: BRAT diet, Pedialyte, Zofran PRN.', 60),
    (pid, prov_id, 'In-home sick visit',  'Matthews / Monroe',  '13:00', CURRENT_DATE -  9, 'done',
     'CC: sore throat, fever 101°F. Rapid strep +. Plan: amoxicillin ×10d.', 60),
    (pid, prov2_id,'Text visit',          'South Charlotte',    '09:00', CURRENT_DATE -  8, 'done',
     'Follow-up on ear infection — improving, completing antibiotics.', 15),
    (pid, admin_id,    'In-home sick visit',  'North Charlotte',    '15:00', CURRENT_DATE -  7, 'done',
     'CC: cough ×5d, wheezing. Dx: RAD exacerbation. Plan: albuterol q4h PRN, prednisolone ×3d.', 60),
    (pid, prov_id, 'Video telemedicine',  'Fort Mill',          '11:00', CURRENT_DATE -  6, 'done',
     'CC: red itchy eyes ×4d. Dx: allergic conjunctivitis. Plan: olopatadine BID.', 30),
    (pid, admin_id,    'Sports physical',     'South Charlotte',    '10:00', CURRENT_DATE -  5, 'done',
     'Sports physicals for two siblings. Both cleared for all athletic activities.', 75),
    (pid, prov_id, 'In-home sick visit',  'Fort Mill',          '09:30', CURRENT_DATE -  4, 'done',
     'CC: knee pain after soccer. No fracture on exam. RICE, ibuprofen PRN.', 60),
    (pid, prov2_id,'In-home sick visit',  'Downtown / Midtown', '14:00', CURRENT_DATE -  3, 'done',
     'CC: fever 103°F ×1d, no localising sx. Dx: viral syndrome. Plan: antipyretics, return if worse.', 60),
    (pid, admin_id,    'Video telemedicine',  'South Charlotte',    '16:00', CURRENT_DATE -  2, 'done',
     'Asthma management follow-up. Controller med adjusted to medium-dose ICS.', 30),
    (pid, prov_id, 'Text visit',          'Matthews / Monroe',  '08:00', CURRENT_DATE -  1, 'done',
     'Parent query: 2yo rash after new food. Dx: contact dermatitis. HC 1% cream, Benadryl PRN.', 15);
END IF;

-- ── 9. Historical appointments (past 90 days for analytics charts) ────────────
-- Generates ~60 past appointments spread across 3 months.
IF NOT EXISTS (
  SELECT 1 FROM appointments
  WHERE practice_id = pid AND scheduled_date < CURRENT_DATE - 14
  LIMIT 1
) THEN
  INSERT INTO appointments (practice_id, provider_id, visit_type, zone,
    scheduled_time, scheduled_date, status, duration_minutes)
  SELECT
    pid,
    CASE gs % 3
      WHEN 0 THEN admin_id
      WHEN 1 THEN prov_id
      ELSE prov2_id
    END,
    CASE gs % 6
      WHEN 0 THEN 'In-home sick visit'
      WHEN 1 THEN 'Video telemedicine'
      WHEN 2 THEN 'Sports physical'
      WHEN 3 THEN 'In-home sick visit'
      WHEN 4 THEN 'Text visit'
      ELSE 'In-home sick visit'
    END,
    CASE gs % 4
      WHEN 0 THEN 'North Charlotte'
      WHEN 1 THEN 'South Charlotte'
      WHEN 2 THEN 'Downtown / Midtown'
      ELSE 'Fort Mill'
    END,
    to_char(time '08:00' + (gs % 9 * interval '1 hour'), 'HH24:MI'),
    CURRENT_DATE - gs,
    'done',
    CASE gs % 6 WHEN 1 THEN 30 WHEN 4 THEN 15 ELSE 60 END
  FROM generate_series(15, 90) AS gs
  WHERE (CURRENT_DATE - gs * interval '1 day') NOT IN (
    -- rough weekend exclusion: skip series values that land on Sat/Sun
    SELECT d FROM generate_series(15, 90) AS x(d)
    WHERE extract(dow FROM CURRENT_DATE - x.d) IN (0, 6)
  );
END IF;

-- ── 10. Today's appointments ─────────────────────────────────────────────────
IF NOT EXISTS (
  SELECT 1 FROM appointments WHERE practice_id = pid AND scheduled_date = CURRENT_DATE LIMIT 1
) THEN
  INSERT INTO appointments (practice_id, provider_id, visit_type, zone,
    scheduled_time, scheduled_date, status, duration_minutes)
  VALUES
    (pid, admin_id,    'In-home sick visit',  'North Charlotte',    '09:00', CURRENT_DATE, 'done',        60),
    (pid, admin_id,    'Sports physical',     'South Charlotte',    '11:00', CURRENT_DATE, 'in-progress', 60),
    (pid, prov_id, 'Video telemedicine',  'Matthews / Monroe',  '10:00', CURRENT_DATE, 'done',        30),
    (pid, prov_id, 'In-home sick visit',  'Fort Mill',          '14:00', CURRENT_DATE, 'upcoming',    60),
    (pid, prov2_id,'In-home sick visit',  'Downtown / Midtown', '09:30', CURRENT_DATE, 'done',        60),
    (pid, prov2_id,'Text visit',          'South Charlotte',    '15:00', CURRENT_DATE, 'upcoming',    15);
END IF;

-- ── 11. Upcoming appointments ────────────────────────────────────────────────
IF NOT EXISTS (
  SELECT 1 FROM appointments WHERE practice_id = pid AND scheduled_date > CURRENT_DATE LIMIT 1
) THEN
  INSERT INTO appointments (practice_id, provider_id, visit_type, zone,
    scheduled_time, scheduled_date, status, duration_minutes)
  VALUES
    (pid, admin_id,    'In-home sick visit',  'North Charlotte',    '09:00', CURRENT_DATE + 1, 'upcoming', 60),
    (pid, admin_id,    'Video telemedicine',  'South Charlotte',    '10:30', CURRENT_DATE + 1, 'upcoming', 30),
    (pid, prov_id, 'Sports physical',     'Matthews / Monroe',  '14:00', CURRENT_DATE + 1, 'upcoming', 60),
    (pid, admin_id,    'In-home sick visit',  'Downtown / Midtown', '09:00', CURRENT_DATE + 2, 'upcoming', 60),
    (pid, prov_id, 'In-home IV fluids',   'Fort Mill',          '11:00', CURRENT_DATE + 2, 'upcoming', 90),
    (pid, prov2_id,'Sports physical',     'South Charlotte',    '13:00', CURRENT_DATE + 2, 'upcoming', 60),
    (pid, admin_id,    'Sports physical',     'North Charlotte',    '13:00', CURRENT_DATE + 3, 'upcoming', 60),
    (pid, prov_id, 'In-home sick visit',  'Matthews / Monroe',  '09:00', CURRENT_DATE + 3, 'upcoming', 60),
    (pid, admin_id,    'Video telemedicine',  'North Charlotte',    '15:00', CURRENT_DATE + 4, 'upcoming', 30),
    (pid, prov2_id,'In-home sick visit',  'Downtown / Midtown', '10:00', CURRENT_DATE + 5, 'upcoming', 60);
END IF;

-- ── 12. Open broadcasts ──────────────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM broadcasts WHERE practice_id = pid LIMIT 1) THEN
  INSERT INTO broadcasts (practice_id, patient_first_name, patient_last_name, patient_dob,
    zone, state, visit_type, complaint, is_urgent, is_open, created_by, created_by_name)
  VALUES
    (pid, 'Liam', 'Thompson', '2020-06-12',
     'North Charlotte', 'NC', 'In-home sick visit',
     'High fever 104°F, lethargic, not eating — needs same-day eval',
     true, true, admin_id, 'Dr. Sarah Mitchell'),
    (pid, 'Ava', 'Williams', '2018-11-03',
     'South Charlotte', 'NC', 'In-home sick visit',
     'Vomiting and diarrhea ×2 days, mild dehydration signs',
     false, true, admin_id, 'Dr. Sarah Mitchell');
END IF;

-- ── 13. Pending booking requests ─────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM booking_requests WHERE practice_id = pid LIMIT 1) THEN
  INSERT INTO booking_requests (practice_id, family_id, child_ids, visit_type, zone, state,
    preferred_date, preferred_time, status, reference_code, notes)
  VALUES
    (pid, family_id, ARRAY[child1_id],
     'In-home sick visit', 'North Charlotte', 'NC',
     CURRENT_DATE + 2, '10:00', 'pending', 'REF-DEMO-001',
     'COMPLAINT:Sore throat and mild fever since yesterday|ADDR:1234 Elm Street, Charlotte NC 28078'),
    (pid, family2_id, ARRAY[child3_id],
     'Video telemedicine', 'South Charlotte', 'NC',
     CURRENT_DATE + 3, '14:00', 'pending', 'REF-DEMO-002',
     'COMPLAINT:Rash on arms and legs, no fever, no new exposures');
END IF;

-- ── 14. Waitlist entries ─────────────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM waitlist_entries WHERE practice_id = pid LIMIT 1) THEN
  INSERT INTO waitlist_entries (practice_id, family_id, child_ids, visit_type, zone, state,
    preferred_time_window, complaint, status)
  VALUES
    (pid, family_id, ARRAY[child2_id],
     'In-home sick visit', 'North Charlotte', 'NC',
     'morning', 'Recurring ear infections — wants to be seen as soon as a slot opens', 'waiting'),
    (pid, family2_id, ARRAY[child4_id],
     'In-home sick visit', 'Fort Mill', 'SC',
     'any', 'Cough and congestion ×4 days, low-grade fever', 'waiting');
END IF;

RAISE NOTICE 'Demo seed complete. Practice: Crestview Pediatrics (%)' , pid;

END $$;
