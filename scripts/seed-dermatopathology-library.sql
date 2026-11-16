-- Seed Dr. Cash's dermatopathology starter library.
-- Dr. Cash's practice id: f5129690-9d54-42d5-b0d5-5450e4de5309 (Direct Dermatology).
-- Paste this directly into the Neon SQL editor against the prod DB.
-- Safe to re-run: ON CONFLICT DO NOTHING deduplicates on (practice_id, resource_type, label).

-- Make the dedupe safe. One-shot — fine to run every time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_result_diagnoses_practice_label
  ON result_diagnoses(practice_id, resource_type, lower(label));

INSERT INTO result_diagnoses (practice_id, resource_type, label, short_code, sort_order) VALUES
  -- BCC variants (10s)
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Basal cell carcinoma, nodular',                    'BCC-N',    10),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Basal cell carcinoma, superficial',                'BCC-S',    11),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Basal cell carcinoma, morpheaform/infiltrative',   'BCC-MI',   12),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Basal cell carcinoma, pigmented',                  'BCC-P',    13),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Basal cell carcinoma, micronodular',               'BCC-MN',   14),
  -- SCC variants (20s)
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Squamous cell carcinoma, well-differentiated',     'SCC-WD',   20),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Squamous cell carcinoma, moderately differentiated','SCC-MD',  21),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Squamous cell carcinoma, poorly differentiated',   'SCC-PD',   22),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Squamous cell carcinoma in situ (Bowen''s disease)','SCCIS',   23),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Keratoacanthoma',                                  'KA',       24),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Actinic keratosis',                                'AK',       25),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Actinic keratosis with early SCC',                 'AK-eSCC',  26),
  -- Melanocytic lesions (30s)
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Melanoma, superficial spreading',                  'MM-SS',    30),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Melanoma, nodular',                                'MM-N',     31),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Melanoma, lentigo maligna',                        'MM-LM',    32),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Melanoma in situ',                                 'MIS',      33),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Melanoma, acral lentiginous',                      'MM-AL',    34),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Dysplastic nevus, mild atypia',                    'DN-mild',  35),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Dysplastic nevus, moderate atypia',                'DN-mod',   36),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Dysplastic nevus, severe atypia',                  'DN-sev',   37),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Compound nevus',                                   'Comp-N',   38),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Intradermal nevus',                                'Intra-N',  39),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Junctional nevus',                                 'Junc-N',   40),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Spitz nevus',                                      'Spitz',    41),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Blue nevus',                                       'Blue-N',   42),
  -- Benign lesions (50s)
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Seborrheic keratosis',                             'SK',       50),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Dermatofibroma',                                   'DF',       51),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Epidermal inclusion cyst',                         'EIC',      52),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Lipoma',                                           'Lipoma',   53),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Pyogenic granuloma',                               'PG',       54),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Cherry angioma',                                   'CA',       55),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Skin tag / acrochordon',                           'Tag',      56),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Lichenoid keratosis',                              'LK',       57),
  -- Inflammatory / other (60s)
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Lichen planus',                                    'LP',       60),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Psoriasiform dermatitis',                          'PSO',      61),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Spongiotic dermatitis',                            'SPG',      62),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Granuloma annulare',                               'GA',       63),
  -- Admin outcomes (90s)
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Insufficient tissue for diagnosis',                'INSUF',    90),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'No residual tumor',                                'NO-RES',   91),
  ('f5129690-9d54-42d5-b0d5-5450e4de5309', 'pathology', 'Scar tissue only',                                 'SCAR',     92)
ON CONFLICT (practice_id, resource_type, lower(label)) DO NOTHING;
