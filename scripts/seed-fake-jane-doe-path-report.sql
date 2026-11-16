-- Seed a realistic-looking fake pathology report for Jane Doe on
-- Dr. Cash's practice. Simulates what an integrated lab feed would
-- look like — every field pre-populated, no manual upload needed.
-- Idempotent: the WHERE NOT EXISTS clause skips if the same fake
-- report already lives on her chart.

WITH patient AS (
  SELECT id AS patient_profile_id
  FROM patient_profiles
  WHERE practice_id = 'f5129690-9d54-42d5-b0d5-5450e4de5309'::uuid
    AND lower(first_name) = 'jane'
    AND lower(last_name)  = 'doe'
  LIMIT 1
)
INSERT INTO results (
  practice_id, patient_profile_id, type,
  received_at, specimen_date, specimen_type, specimen_site,
  source_lab, source_provider,
  report_text, margins_status, icd10_codes,
  status
)
SELECT
  'f5129690-9d54-42d5-b0d5-5450e4de5309'::uuid,
  patient.patient_profile_id,
  'pathology',
  NOW(),
  (CURRENT_DATE - INTERVAL '6 days')::date,
  'Shave biopsy',
  'Left ear helix',
  'Southern Dermatopathology Associates',
  'Michael Chen, MD',
  'CLINICAL HISTORY:' || chr(10) ||
  '   Scaly, tender lesion on left ear helix, growing over 3 months.' || chr(10) || chr(10) ||
  'SPECIMEN:' || chr(10) ||
  '   Shave biopsy, left ear helix.' || chr(10) || chr(10) ||
  'GROSS DESCRIPTION:' || chr(10) ||
  '   Single tan-pink skin fragment, 6 x 5 x 2 mm. Submitted in toto.' || chr(10) || chr(10) ||
  'MICROSCOPIC DESCRIPTION:' || chr(10) ||
  '   Sections show an invasive neoplasm composed of atypical squamous cells' || chr(10) ||
  '   arranged in irregular nests and cords, extending from the epidermis into' || chr(10) ||
  '   the reticular dermis. The tumor cells show abundant eosinophilic cytoplasm' || chr(10) ||
  '   with keratin pearl formation and only mild to moderate nuclear atypia,' || chr(10) ||
  '   consistent with a well-differentiated phenotype. Perineural invasion is' || chr(10) ||
  '   not identified. Lymphovascular invasion is not identified.' || chr(10) || chr(10) ||
  '   Deep margin: tumor extends to the deep margin of the specimen.' || chr(10) ||
  '   Peripheral margins: tumor extends to one peripheral margin.' || chr(10) || chr(10) ||
  'DIAGNOSIS:' || chr(10) ||
  '   Skin, left ear helix, shave biopsy — Squamous cell carcinoma,' || chr(10) ||
  '   well-differentiated, extending to deep and peripheral margins.' || chr(10) || chr(10) ||
  'COMMENT:' || chr(10) ||
  '   Margins are involved. Recommend complete excision or Mohs.',
  'Positive — involved at deep and peripheral margins',
  ARRAY['C44.21']::text[],
  'pending_review'
FROM patient
WHERE NOT EXISTS (
  SELECT 1 FROM results r
  WHERE r.practice_id = 'f5129690-9d54-42d5-b0d5-5450e4de5309'::uuid
    AND r.patient_profile_id = patient.patient_profile_id
    AND r.specimen_site = 'Left ear helix'
    AND r.source_lab = 'Southern Dermatopathology Associates'
);

-- Quick sanity check — should see 1 pending_review path row on Jane Doe.
SELECT r.id, r.received_at, r.specimen_type, r.specimen_site, r.source_lab,
       r.margins_status, r.status
FROM results r
JOIN patient_profiles pp ON pp.id = r.patient_profile_id
WHERE r.practice_id = 'f5129690-9d54-42d5-b0d5-5450e4de5309'::uuid
  AND pp.first_name ILIKE 'jane' AND pp.last_name ILIKE 'doe'
ORDER BY r.received_at DESC;
