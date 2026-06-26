-- ─────────────────────────────────────────────────────────────────────────────
-- New Practice Setup Template
-- Run this in the Neon SQL editor before deploying a new practice.
-- Replace all <PLACEHOLDER> values before running.
-- ─────────────────────────────────────────────────────────────────────────────

-- Step 1: Create the practice row
-- slug must be URL-safe, lowercase, hyphenated (used to look up practice in migrations)
INSERT INTO practices (name, slug, tagline, city, state, phone, email, subscription_tier)
VALUES (
  '<PRACTICE NAME>',           -- e.g. 'Happy Kids Housecalls'
  '<practice-slug>',           -- e.g. 'happy-kids-housecalls'
  '<tagline>',                 -- e.g. 'Mobile pediatric urgent care · Austin, TX'
  '<city>',                    -- e.g. 'Austin'
  '<state>',                   -- e.g. 'TX'
  '<phone>',                   -- e.g. '512-555-1234'
  '<email>',                   -- e.g. 'info@happykidshousecalls.com'
  'standard'
)
ON CONFLICT (slug) DO NOTHING
RETURNING id, name, slug;

-- ⚠️  Copy the `id` from the row above — you need it for VITE_PRACTICE_ID in Vercel.

-- Step 2: Seed visit types for this practice.
-- Replace <PRACTICE_ID> with the UUID returned above.
-- Customize visit_type names, prices, and flags for this practice.
-- has_convenience_fee: true = distance-based fee charged after visit
-- is_in_home: true = family must provide a visit address
-- is_cpr: true = uses CPR booking flow (participants, not children)
-- per_child_extra_minutes: minutes added per additional child (0 for most types)
INSERT INTO practice_visit_types
  (practice_id, visit_type, base_price, badge_label, badge_color, badge_text_color,
   duration_minutes, lead_minutes, has_convenience_fee, per_child_extra_minutes,
   is_in_home, is_cpr, is_active, sort_order)
VALUES
  ('<PRACTICE_ID>'::uuid, 'In-home sick visit',             150, 'Sick visit',      '#EEEDFE', '#3C3489', 60,  60,  true,  15, true,  false, true, 1),
  ('<PRACTICE_ID>'::uuid, 'Video telemedicine',              75, 'Telemedicine',    '#E1F5EE', '#085041', 30,  30,  false,  0, false, false, true, 2),
  ('<PRACTICE_ID>'::uuid, 'Sports physical',                125, 'Sports physical', '#FAEEDA', '#633806', 60,  60,  true,  15, true,  false, true, 3),
  ('<PRACTICE_ID>'::uuid, 'Text visit',                      50, 'Text visit',      '#FBEAF0', '#993556', 15,  30,  false,  0, false, false, true, 4)
  -- Add more rows as needed for this practice:
  -- ('<PRACTICE_ID>'::uuid, 'CMA + telemedicine', 125, 'CMA + tele', '#E6F1FB', '#0C447C', 60, 60, true, 15, true, false, false, 5),
ON CONFLICT (practice_id, visit_type) DO NOTHING;

-- Step 3: Zones are managed via the AdminProvision UI after the first provider logs in.
-- No SQL needed here — add zones through the web interface.

-- ─────────────────────────────────────────────────────────────────────────────
-- After running this SQL, complete these steps:
--
-- 1. Create a Cognito User Pool in AWS (us-east-2 or your preferred region)
--    - App client: no client secret, enable USER_PASSWORD_AUTH + USER_SRP_AUTH
--    - Note the User Pool ID and App Client ID
--
-- 2. Create a new Vercel project (fork the roam-platform repo)
--    Set these environment variables:
--      VITE_PRACTICE_ID          = <UUID from Step 1 above>
--      VITE_PRACTICE_NAME        = <Practice display name>
--      VITE_PRACTICE_TAGLINE     = <Tagline for login page>
--      VITE_ACCENT_COLOR         = <Hex color, e.g. #7F77DD>
--      VITE_VENMO_HANDLE         = <Venmo username, if CPR classes offered>
--      VITE_AWS_REGION           = us-east-2
--      VITE_AWS_USER_POOL_ID     = <Cognito User Pool ID>
--      VITE_AWS_CLIENT_ID        = <Cognito App Client ID>
--      DATABASE_URL              = <Neon connection string>
--      AWS_ADMIN_ACCESS_KEY_ID   = <IAM key with Cognito admin permissions>
--      AWS_ADMIN_SECRET_ACCESS_KEY = <IAM secret>
--      BOOTSTRAP_SECRET          = <Random strong secret, e.g. openssl rand -hex 32>
--      PRACTICE_NAME             = <Same as VITE_PRACTICE_NAME>
--      FROM_EMAIL                = <Verified Resend sender address>
--      PORTAL_URL                = <https://your-vercel-domain.vercel.app>
--      TELEMEDICINE_URL          = <Video visit room URL>
--      GOOGLE_REVIEW_URL         = <Google Maps review link>
--      VENMO_HANDLE              = <Same as VITE_VENMO_HANDLE>
--
-- 3. Deploy the Vercel project, then call the bootstrap endpoint once:
--      curl -X POST https://<your-domain>/api/admin/bootstrap \
--        -H "Content-Type: application/json" \
--        -H "X-Bootstrap-Secret: <BOOTSTRAP_SECRET>" \
--        -d '{"name":"Dr. Jane Smith","email":"jane@happykidshousecalls.com"}'
--    The first provider is created as super admin and receives a Cognito invite email.
--
-- 4. After the super admin logs in, remove BOOTSTRAP_SECRET from Vercel env vars
--    so the bootstrap endpoint becomes permanently inert.
-- ─────────────────────────────────────────────────────────────────────────────
