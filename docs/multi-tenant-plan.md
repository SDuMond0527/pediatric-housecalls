# GoRoam Multi-Practice Plan

## Plain-language summary (read this first)

Right now GoRoam only knows about one practice — Pediatric Housecalls. Everything the code does assumes "the practice is PHC." Adding Sarah Cash as a second, separate practice means we have to teach the code that there's more than one practice and that each one gets its own data and its own on/off switches for features.

**The plan has two big pieces:**

1. **A settings tab.** Each practice gets a list of on/off switches ("does this practice do in-home visits?" "does it take insurance?" "does it use IV fluids?"). Flipping a switch changes what that practice sees in the app. You've already been asking for this — it's what makes future practices a configuration job instead of a code job.

2. **Teaching the app which practice a person belongs to.** Today, every login lands in PHC. We need the login to check "which practice is this person in?" and show only that practice's data. This is the piece with real regression risk for PHC — I spelled out how to keep PHC safe in §4.

**The order matters.** We build the settings tab FIRST with every switch turned on for PHC (so PHC keeps behaving identically). We get PHC running on the new plumbing with no behavior change. ONLY AFTER that is proven solid do we touch the "which practice am I in" change. Sarah Cash doesn't go live until PHC has run a week clean on the new code.

**Timeline:** about 3-4 weeks.

**What I need from you before I start:** read §2 (the switch list) and tell me what I got wrong for Sarah Cash, and answer the questions in §6.

---

## Ground rules check (your 8 standing rules)

| # | Rule | How this plan honors it |
|---|---|---|
| 1 | Plan first | This document. No code written. Waiting for your OK. |
| 2 | Never change the record | This refactor touches how practice_id is looked up, not what gets stored in charts / claims / appointments. No chart data, claim data, or appointment data is altered by this work. Noted — this is infrastructure, not a feature with artifacts. |
| 3 | Log everything it generates | **Added as a hard requirement:** every settings change (who flipped which switch, for which practice, when) writes to a `practice_settings_audit` table. See §9. |
| 4 | Drafts before sending | N/A — nothing is being sent to families, schools, or partners by this work. |
| 5 | No clinical decisions | N/A — pure infrastructure. |
| 6 | Protect patient information | N/A directly; enforced indirectly via Rule 7. |
| 7 | Keep practices separate | **This refactor IS the Rule 7 enforcement.** Every data query will include a practice_id filter derived from the logged-in user. Acceptance test: a user in Practice A tries to load data for Practice B and gets nothing — not even a 404 leak. See §4. |
| 8 | Test end to end, incl. phone | **Added to every phase exit criteria:** desktop + iPhone-sized Safari + Android-sized Chrome tested before phase is called done. See §3. |

---

## 0. What we're actually building NOW — the skeleton

Sara confirmed 2026-11-04: this first pass is **try-it-out level** for Sarah Cash. The goal is she logs in, adds herself as a provider, creates a test patient, books a visit, and signs a note. Kicks the tires. No real patients yet, no vendor integrations, no family-facing portal.

**In scope for the skeleton:**
- Settings infrastructure (§3 Phase 1) — the on/off switches live on each practice.
- Flag the big hides for Sarah Cash's shell: no claims pipeline, no CV fees, no zones, no hybrid tele, no IV fluids, no CPR classes, no broadcasts, no payroll module, no co-sign workflow, no waitlist auto-EOD. Her shell looks clean and spartan.
- Multi-tenant auth (§3 Phase 3) — her login drops her in her own data; PHC's login drops them in PHC.
- Sarah Cash's practice row + her Cognito login + minimum identity values (name, timezone, one dummy office address).
- Mobile testing all the way through.
- Audit log (§9).

**Deferred until Sarah commits to using it for real:**
- Vendor integrations — DoseSpot, Stripe, Twilio, Resend domain (she doesn't have credentials yet; flags stay OFF, so nothing in the UI tries to call these services).
- Office-room scheduling (§5) — for skeleton, "one virtual room, no physical modeling." She picks a time slot like any solo provider.
- Patient portal / family self-signup — no family-facing surfaces for Sarah Cash yet.
- Practice-admin settings UI (Phase 5) — you'll edit her toggles from super-admin until she's ready for self-serve.
- Lab orders / radiology orders — flag off unless she asks.

**Revised timeline:** ~10-12 working days, 2 to 2.5 calendar weeks.

**Questions I still need answered before Phase 1 starts:**
1. Where does Sarah Cash log in? Options:
   - **A.** Same `phc-team.com` login page; her account maps to her practice automatically. Simplest. Only her URL branding is "GoRoam / PHC" until production.
   - **B.** A subdomain like `saracash.phc-team.com`. Cleaner for her, more work to set up.
   - For try-it-out I'd recommend **A** — subdomain can come later with zero code impact.
2. Her approximate timeline — days / weeks / no rush? Shapes how much overlap with PHC testing I build in.

Once those two are answered, Phase 1 can start.

---

## Full production roadmap (everything below is beyond the skeleton)

**Goal:** Onboard Sarah Cash, MD as a fully isolated second practice on GoRoam, AND build the foundation so future practices (#3, #4, …) are onboarded via configuration — not code changes.

**Non-goal:** Changing anything about how Pediatric Housecalls (PHC) behaves today. PHC must remain pixel-identical through this entire project.

---

## 1. Architecture

### 1.1 The core move

Today: `VITE_PRACTICE_ID` is hardcoded in env. Every request assumes PHC.
After: `practice_id` comes from the logged-in user. Each practice has its own `practice_settings` JSONB blob that gates features and supplies values.

### 1.2 Data model

**New column on `practices`:**

```sql
ALTER TABLE practices
  ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb;
```

JSONB (not a separate table) because:
- Fast to iterate on — new toggle = new key, no migration
- Simple to load as one blob at login
- Can migrate hot-read fields into typed columns later if we need indexes

Schema validated at write-time with Zod. `practice_settings.schema.ts` holds the canonical type.

### 1.3 Session shape

On login, after resolving `practice_id` from the user's record, we load the practice's row once and stash `{ practice_id, settings }` in an auth context. Every component / API handler reads from there instead of env.

---

## 2. Feature toggles

Grouped by concern. ✅ = on by default for PHC, ❌ = off for Sarah Cash's use case.

### 2.1 Visits & clinical workflow

| Flag | PHC | Sarah Cash | What it gates |
|---|---|---|---|
| `visits_are_in_home` | ✅ | ❌ | Zones, driving directions, patient address on cards, CV fees |
| `uses_office_locations` | ❌ | ✅ | Office address, exam rooms, "come to the office" copy |
| `uses_convenience_fees` | ✅ | ❌ | CV11/CV21/CV31, auto-attach, Square auto-charge pipeline |
| `uses_hybrid_tele_visits` | ✅ | ❌ | CMA + telemedicine paired bookings |
| `uses_iv_fluids` | ✅ | ❌ | RN IV fluids visit, 96360 + E86.0 defaults |
| `uses_cpr_classes` | ✅ | ❌ | CPR class visit type, adult participants, cert tracking |
| `uses_telemedicine` | ✅ | ❌/✅ | Video telemed visit type, mod 95 / POS 10 auto-logic |
| `uses_text_visits` | ✅ | ❌ | Text visit type, auto self-pay |
| `uses_sports_physicals` | ✅ | ❌/✅ | Sports physical visit type |
| `uses_vaccine_administration` | ✅ | ❌ | In-home vaccine visit type |
| `uses_sick_visits` | ✅ | ❌ | In-home sick visit |
| `uses_ear_piercing` | ❌ | ❌ | Ear piercing visit type (currently inactive anyway) |

### 2.2 Billing & insurance

| Flag | PHC | Sarah Cash | What it gates |
|---|---|---|---|
| `accepts_insurance` | ✅ | ❌ | Claims pipeline, claim scrubber, Pending Review tab, Submit to Insurance button, Stedi integration, ERA pipeline, 277 handling, Rework tab |
| `uses_self_pay_statements` | ✅ | ✅ | Patient statement generation, Stripe charge, "paid" status |
| `uses_stripe_card_on_file` | ✅ | ✅ | Save card at intake, auto-charge, retry logic |
| `uses_square_auto_charge` | ✅ | ❌ | Square-side CV fee auto-charge (legacy; may deprecate) |
| `aetna_poc_swap_enabled` | ✅ | ❌ | Auto-swap 87880/87812/81002 → self-pay codes |
| `bcbs_nc_dep_code_check` | ✅ | ❌ | Scrubber warning for missing dep code |

### 2.3 Provider workflow

| Flag | PHC | Sarah Cash | What it gates |
|---|---|---|---|
| `uses_cosign_workflow` | ✅ | ❌ | NP → MD co-signature flow (Sarah Cash is solo MD, nothing to cosign) |
| `uses_waitlist` | ✅ | ✅ | Waitlist tab, auto-EOD |
| `uses_broadcasts` | ✅ | ❌ | Shift pick-up broadcasts (solo practice, no shifts to pick up) |
| `uses_payroll_module` | ✅ | ❌ | Admin payroll report (solo MD, no payroll) |
| `uses_dosespot_eprescribing` | ✅ | ✅ | DoseSpot buttons, pharmacy picker — assumes she gets her own DoseSpot clinician ID |
| `uses_lab_orders` | ✅ | ✅/❌ | Outside labs menu, Labcorp requisitions — Sarah's call |
| `uses_radiology_orders` | ✅ | ✅/❌ | Radiology order form |

### 2.4 Family-facing

| Flag | PHC | Sarah Cash | What it gates |
|---|---|---|---|
| `uses_patient_portal` | ✅ | ✅/❌ | Family login, self-book, family profile — Sarah's call |
| `uses_family_signup` | ✅ | ✅/❌ | Public /signup route |
| `uses_booking_requests` | ✅ | ❌ | Clinician / agency referral intake forms |
| `uses_phi_secure_links` | ✅ | ✅ | Encrypted PHI distribution links |

### 2.5 Integrations (values, not toggles)

Each practice supplies its own, or leaves blank to disable:

- `dosespot_clinic_id` + `dosespot_clinic_key`
- `stedi_api_key_ref` (reference to vault — only if `accepts_insurance = true`)
- `labcorp_account_number`
- `stripe_account_id`
- `twilio_phone_number`
- `resend_from_domain`
- `resend_from_name`

### 2.6 Practice identity (values)

- `legal_name`, `dba`, `tax_id`, `group_npi`, `taxonomy`
- `address_line1`, `city`, `state`, `zip`
- `main_phone`, `billing_phone`
- `timezone` (default America/New_York)
- `business_hours` (JSON — day-of-week → open/close)
- `brand_color_primary`, `brand_color_accent`
- `logo_url`
- `statement_footer_text`
- `email_signature_html`

### 2.7 Scheduling model

| Flag | PHC | Sarah Cash | What it gates |
|---|---|---|---|
| `uses_zones` | ✅ | ❌ | Geographic zones for in-home routing |
| `uses_office_room_scheduling` | ❌ | ✅ | Exam room availability (new capability — see §5) |
| `availability_overrides_only` | ✅ | ❌ | Parent-portal: no standing availability fallback (PHC rule) |

---

## 3. Implementation phases

### Phase 1 — Settings infrastructure
1. Add `settings jsonb` column to `practices` + Zod schema.
2. Seed PHC's row with all flags ON (so behavior is unchanged).
3. Add `practice_settings_context.tsx` that loads at login and provides `useSettings()`.
4. Add server-side helper `getPracticeSettings(practice_id)` with 5-min in-memory cache.
5. Build super-admin "Practice Settings" tab (you can toggle flags per practice).

**Exit criteria:** 
- PHC continues to work identically.
- No flag checks wired in yet — it's all scaffolding.
- Super-admin tab tested on desktop, iPhone-sized Safari, Android-sized Chrome.
- Audit log (§9) writes a row every time you flip a toggle.

### Phase 2 — Wire PHC-specific code to flags
Audit every "PHC-specific" assumption and route through a flag. Keep all flags ON for PHC so behavior is identical. Examples:

- `AdminClaims.tsx` — gate the whole tab on `accepts_insurance`
- `EncounterNoteModal.tsx` — hide CV fee buttons if `uses_convenience_fees = false`
- `appointments/index.ts` — only fetch zones if `uses_zones = true`
- `convenience-fee.ts` — early-return if `uses_convenience_fees = false`
- Visit type picker — filter `DEFAULT_CPTS_FOR_VISIT_TYPE` by what's enabled
- Patient card address display — only if `visits_are_in_home = true`
- Encounter note co-sign button — only if `uses_cosign_workflow = true`
- …etc. Complete audit list produced during Phase 2.

**Exit criteria:** 
- Every path checked. 
- PHC regression suite passes end-to-end against preview DB with flags-on.
- Mobile check: Sara logs in on her iPhone, runs through Today + Pending Review + patient chart + encounter note sign + statement send — zero visible changes from current prod.
- One kill-switch env var (`FORCE_PHC_LEGACY`) that bypasses settings entirely and reverts to today's behavior.

### Phase 3 — Multi-tenant auth
1. `providers.practice_id` is already the source of truth. Confirm every provider row has it set.
2. Replace all `process.env.VITE_PRACTICE_ID` reads with `getUserPracticeId(sub)`.
3. Family side: `family_profiles.practice_id` scoped — add column if missing.
4. Decide subdomain vs path routing (see §6).
5. Make cron jobs iterate over all practices instead of assuming PHC.

**Exit criteria:** 
- Create a dummy test practice in the preview DB. 
- A user assigned to it sees a completely empty app shell. 
- PHC users see PHC. 
- No cross-contamination — explicit test: dummy-practice user tries to load a PHC child's chart by UUID via the API, gets 403 or empty, never actual data.
- Mobile check: same cross-contamination test on iPhone-sized viewport.

### Phase 4 — Onboard Sarah Cash
1. Create her `practices` row with her settings blob (all the flags from §2 above).
2. Set up her Cognito user (and any staff she has).
3. Load her office address, business hours, DoseSpot ID, Stripe account.
4. Smoke test: she logs in, sees her (empty) schedule, can book a cash-pay office visit, can sign a note, can generate a statement, can charge a card.
5. PHC users log in separately and see no change.

**Exit criteria:** 
- Both practices live, isolated. 
- Mobile check: Sarah Cash logs in from her iPhone, books a cash-pay visit, signs a note, charges a card. End to end.
- One week of overlap with PHC monitoring to catch anything subtle.

### Phase 5 — Practice-admin settings UI (post-launch)
Let practice admins (not just super-admin) flip their own practice's safe toggles. Some flags you keep super-admin-only (`accepts_insurance`, `dosespot_clinic_id`) because flipping them has blast radius.

---

## 4. Safety / rollout

- **Preview Neon branch is the staging ground.** Every change tested there first per the standing rule.
- **`FORCE_PHC_LEGACY` env var** kills the whole settings path and reverts to today's behavior. One-env-var rollback.
- **Phase 1 + 2 ship before Phase 3.** The hardest part (multi-tenant auth) comes AFTER PHC is already running through the flags path with all flags on — so by the time we flip auth, the flags layer is already battle-tested on PHC.
- **Sarah Cash doesn't come online until PHC has run a full week on the new code with zero regressions.**
- **No destructive migrations.** All new columns are additive with defaults.

---

## 5. New capability needed — office-based scheduling

Current scheduling is built around "a provider is in zone X for N hours." Sarah Cash's model is "patient comes to the office at 10:30 to exam room 2."

Minimum viable:
- `office_locations` table (practice_id, name, address, room_count)
- `appointments.office_location_id` (nullable — only used when `uses_office_locations = true`)
- Scheduling UI uses time slots instead of zone+time strings

**Scope:** 2-3 extra days of work layered onto Phase 4. Could defer by starting Sarah Cash with "one virtual exam room" and no physical-space modeling — she'd book slots just like a solo provider.

---

## 6. Open questions for Sara

1. **Subdomain vs path?** `saracash.goroam.com` or `www.phc-team.com/saracash`? Subdomain is cleaner for branding and cookies; path is simpler to deploy. Recommend subdomain.
2. **Does Sarah Cash use her own vendor accounts, or ride on PHC's?**
   - DoseSpot: likely her own (DEA + state license tied to her, not PHC)
   - Stripe: likely her own (she keeps her revenue separate)
   - Twilio: could share — just need a different sender number
   - Resend: she'd want her own domain (`saracash.com` not `phc-team.com`)
3. **Does she want a parent-facing self-booking portal, or internal scheduling only?**
4. **Her office address, phone, hours, timezone, logo, brand color?**
5. **Does she have staff (MA, front desk) or solo?**
6. **Timeline — when does she need this live?**
7. **Pricing — is she paying you a monthly SaaS fee to use GoRoam?** Affects what we track and whether we need per-practice billing on OUR side too.

---

## 7. Estimate

- Phase 1 (infrastructure): ~3 days
- Phase 2 (flag audit + wiring): ~4 days
- Phase 3 (multi-tenant auth): ~3 days
- Phase 4 (Sarah Cash onboarding): ~2 days + 1 week observation
- Phase 5 (practice-admin UI): ~2 days (post-launch)
- Plus office-scheduling (§5): ~2-3 days

**Total working time: ~14-16 days.** Calendar: 3 weeks if everything goes clean, 4 weeks with normal iteration.

---

## 8. What I need from you to start

1. Answers to §6 open questions.
2. Explicit go-ahead on Phase 1 before any code lands.
3. Review of the §2 flag list — tell me what I missed or got wrong for Sarah Cash's specific use case.

No code written yet. Awaiting review.

---

## 9. Audit log for settings changes (Rule 3)

Every flip of a toggle or edit to a practice-identity value is logged. Nothing happens silently.

**New table:**

```sql
CREATE TABLE practice_settings_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id uuid NOT NULL REFERENCES practices(id),
  changed_by_provider_id uuid REFERENCES providers(id),
  changed_by_name text,
  field_path text NOT NULL,         -- e.g. "visits_are_in_home" or "brand_color_primary"
  old_value jsonb,
  new_value jsonb,
  changed_at timestamptz DEFAULT now()
);
```

**Behavior:**
- Super-admin "Practice Settings" tab writes an audit row for every single field change on Save.
- UI surfaces a "History" button per practice that reads this table and shows who changed what, when.
- Audit rows are never deletable or editable.

**Why this matters:** if Sarah Cash's claims pipeline silently flips on because someone bumped a toggle, you want to know who did it and when. Same for PHC — if any PHC flag ever gets flipped by accident, there's a trail.
