CREATE TABLE IF NOT EXISTS practice_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id uuid REFERENCES practices(id) ON DELETE CASCADE NOT NULL,
  zone_name text NOT NULL,
  state text,
  zips text[] NOT NULL DEFAULT '{}',
  is_waitlist_only boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE(practice_id, zone_name)
);
CREATE INDEX IF NOT EXISTS idx_practice_zones_practice ON practice_zones(practice_id);

-- Seed existing PHC zones from the hardcoded zipData.ts
DO $$
DECLARE pid uuid;
BEGIN
  SELECT id INTO pid FROM practices WHERE slug = 'pediatric-house-calls';
  IF pid IS NULL THEN RAISE NOTICE 'PHC practice not found — skipping seed'; RETURN; END IF;
  INSERT INTO practice_zones (practice_id, zone_name, state, zips, is_waitlist_only, sort_order) VALUES
    (pid, 'Huntersville / Davidson / Cornelius', 'NC', ARRAY['28078','28036','28031'], false, 1),
    (pid, 'Concord',                             'NC', ARRAY['28025','28027'],          false, 2),
    (pid, 'Kannapolis',                          'NC', ARRAY['28081'],                  false, 3),
    (pid, 'Harrisburg',                          'NC', ARRAY['28075'],                  false, 4),
    (pid, 'Mooresville',                         'NC', ARRAY['28117','28115'],           false, 5),
    (pid, 'Ballantyne / Providence',             'NC', ARRAY['28226','28270','28277'],   false, 6),
    (pid, 'Cotswold / SouthPark',                'NC', ARRAY['28203','28204','28205','28207','28209','28210','28211'], false, 7),
    (pid, 'Waxhaw / Weddington / Marvin',        'NC', ARRAY['28173'],                  false, 8),
    (pid, 'Matthews',                            'NC', ARRAY['28104','28105','28106'],   false, 9),
    (pid, 'Denver',                              'NC', ARRAY['28037'],                  true,  10),
    (pid, 'University',                          'NC', ARRAY['28269','28262'],           false, 11),
    (pid, 'Oakdale',                             'NC', ARRAY['28214','28216'],           false, 12),
    (pid, 'Greater Raleigh',                     'NC', ARRAY['27601','27603','27604','27605','27606','27607','27608','27609','27610','27612','27613','27614','27615','27616','27617','27540','27539'], false, 13),
    (pid, 'York / Lake Wylie / Clover',          'SC', ARRAY['29745','29710'],           false, 14),
    (pid, 'Indianland',                          'SC', ARRAY['29707'],                  false, 15),
    (pid, 'Fort Mill',                           'SC', ARRAY['29708','29715','29716'],   false, 16),
    (pid, 'Rock Hill',                           'SC', ARRAY['29730','29731','29734'],   false, 17),
    (pid, 'Leesburg area',                       'VA', ARRAY['20175','20176','20158','20132','20141','20197','20129'], false, 18),
    (pid, 'Great Falls',                         'VA', ARRAY['22066'],                  false, 19),
    (pid, 'Reston',                              'VA', ARRAY['20190','20191','20194'],   false, 20),
    (pid, 'Gainesville',                         'VA', ARRAY['20155'],                  false, 21),
    (pid, 'Ashburn / Sterling',                  'VA', ARRAY['20147','20148','20164','20165','20166'], false, 22),
    (pid, 'Chantilly / Centreville',             'VA', ARRAY['20105','20151','20152','20171','20120'], false, 23)
  ON CONFLICT (practice_id, zone_name) DO NOTHING;
END $$;
