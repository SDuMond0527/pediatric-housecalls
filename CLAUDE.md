# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Pre-push discipline — do not skip

Three rules Sara put in place on 2026-10-01 after a chain of 500s
reached end users. All three are non-negotiable.

### 1. Run smoke tests before every push

```
npm run smoke
```

Replays representative SQL from each API handler against the
preview branch (uses `.env.local` DATABASE_URL). Any failure =
DO NOT push. Fix the SQL / schema / bootstrap first.

Catches the class of bug where code assumes a column type or shape
that doesn't match the actual schema (e.g. the "text ≤ time without
time zone" cast error that silently 500'd every CMA+tele booking on
2026-10-01 until Keaira hit it in the field).

When adding a new API endpoint or a new SQL query to an existing
one, add a representative check to the `CHECKS` array in
`scripts/smoke/run.mjs`.

If a smoke test fails with "column does not exist", the preview
branch is behind prod. Catch it up by running the same ALTER TABLE /
CREATE TABLE IF NOT EXISTS bootstraps the API handler would run,
then re-run smoke.

### 2. "Verified" means showing the test output

When I say "I verified this works," I paste the actual command I
ran and its result into chat. Not "I checked, it works." Not
"end-to-end tested." The literal output. If I can't show the
output, I didn't verify it.

Rationale: Sara has repeatedly caught me saying "verified" when I
had only reasoned about the code or run a partial check. The output
is the proof.

### 3. Build safety nets before features

If a bug reveals a gap in safety infrastructure (no test caught it,
no error log recorded it, no monitor paged on it), fix the gap
BEFORE shipping the next feature. Sara called this out directly on
2026-10-01 — she'd rather have fewer features that work reliably
than more features that need babysitting.

## Commands

```bash
npm run dev          # Start Vite dev server
npm run build        # Type-check + build (tsc -b && vite build)
npm run lint         # ESLint (flat config, TypeScript + React hooks rules)
npm run preview      # Preview production build
npm run smoke        # Pre-push smoke tests (see above)

# Supabase edge functions
supabase functions serve <function-name>   # Run function locally
supabase functions deploy <function-name>  # Deploy to production
```

## Architecture

This is a **React + TypeScript + Vite SPA** deployed on Vercel, backed by **Supabase** (PostgreSQL + Auth + Edge Functions written in Deno).

### Three Portals in One App

`src/App.tsx` routes to three distinct experiences based on URL prefix and auth state:

| Portal | Path prefix | Auth context | Entry page |
|--------|------------|--------------|-----------|
| Provider | `/` | `AuthContext` | `Today.tsx` (schedule view) |
| Admin | `/admin/*` | `AuthContext` (admin role) | `AdminAnalytics.tsx` |
| Family | `/family/*` | `FamilyAuthProvider` | `FamilyDashboard.tsx` |

Provider and Admin share `AuthContext` (`src/contexts/`). After login, the role field on the provider record controls which dashboard they reach. Families use a completely separate `FamilyAuthProvider` context with its own session state.

### Key Data Flow

1. **Booking:** Family selects visit type → BookVisit.tsx creates `booking_requests` row → admin accepts → `appointments` row created → `send-notifications` edge function fires (email + SMS to family + assigned provider)
2. **Broadcast:** Admin creates broadcast for urgent/open requests → providers see it on `Broadcasts.tsx` → provider accepts → appointment created
3. **Waitlist:** Family added to waitlist → admin offers slot via `SlotOffer` → family accepts → appointment created
4. **EHR sync:** On appointment creation, `charm-appointment` edge function syncs to Charm Health EHR; `charm-patient` creates the patient record first if needed

### Core Types (`src/types/`)

- `Provider` — role (MD | PNP | CMA | RN | admin), zones[], states[], is_active
- `Appointment` — provider_id, visit_type, zone, scheduled_date/time, status, charm_appointment_id
- `FamilyProfile` / `Child` — stored in Supabase, synced to Charm Health
- `BookingRequest` / `SlotOffer` / `Broadcast` — booking workflow state machines

### Geography (`src/lib/zipData.ts`, `src/lib/constants.ts`)

Service area divided into named zones mapped from ZIP codes. NC (12 zones around Charlotte), SC (Fort Mill, Rock Hill, York/Lake Wylie), VA (Leesburg, Reston, Ashburn corridor). ZIP→Zone and ZIP→State mappings live in `zipData.ts`. Zone list and visit type definitions (name, duration, price) live in `constants.ts`.

### Supabase Edge Functions (`supabase/functions/`)

All written in Deno TypeScript. Key functions:

- **`send-notifications`** — 1,000+ line multi-template system; handles all email (Resend) and SMS (Twilio) for the platform. Templates include booking confirmations, cancellations, waitlist offers, broadcasts, post-visit thank-yous, CPR class confirmations.
- **`calculate-convenience-fee`** — Dynamic pricing: Google Maps distance + time-of-day peak windows + weekend/holiday surcharges + flat overrides for IV/CMA/CPR visits.
- **`charm-appointment`** / **`charm-patient`** / **`get-charm-details`** — Charm Health EHR integration (shared utilities in `_shared/charm.ts`).
- **`save-payment-method`** — Square payment method storage.

### External Integrations

| Service | Purpose | Credentials |
|---------|---------|-------------|
| Supabase | DB, Auth, Edge Functions host | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
| Resend | Transactional email | `RESEND_API_KEY`, `FROM_EMAIL` |
| Twilio | SMS notifications | `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_FROM_NUMBER` |
| Google Maps | Distance calculation for fees | `GOOGLE_MAPS_API_KEY` |
| Charm Health | EHR (Electronic Health Records) | See `_shared/charm.ts` |
| Square | Payment processing | `PORTAL_URL` + Square-specific env vars |

Supabase edge function env vars (Resend, Twilio, Google Maps, Charm, Square credentials) are set in the Supabase dashboard under project secrets, not in `.env`.

### Database Schema

Schema lives in SQL files at the project root: `supabase-schema.sql` (core tables), `supabase-family.sql` (family/booking tables), `supabase-admin.sql`, `supabase-charm.sql` (EHR sync), `supabase-overrides.sql`, `supabase-remove-phi.sql` (PHI removal operations).
