import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider'

// Onboarding entry point for an invited provider.
//
//   GET  /api/onboarding/provider?token=xxx  → resolves invite,
//        returns the invite data the wizard needs to render.
//
//   POST /api/onboarding/provider            → finalizes.
//        Body: { token, ...wizard payload }. Writes the providers row,
//        marks the invite consumed, links to the Cognito account the
//        invite endpoint created.
//
// The token itself is the credential — no JWT required. The invite
// row has expires_at + consumed_at; we fail closed on either.
//
// Sara 2026-11-19.

async function loadInvite(sql: any, token: string) {
  if (!token) return null
  const [inv] = await sql`
    SELECT i.*, p.name AS practice_name,
           sup.name AS supervising_md_name
    FROM provider_invites i
    LEFT JOIN practices p ON p.id = i.practice_id
    LEFT JOIN providers sup ON sup.id = i.supervising_md_id
    WHERE i.token = ${token}
    LIMIT 1`
  return inv ?? null
}

function inviteState(inv: any): 'valid' | 'consumed' | 'expired' | 'missing' {
  if (!inv) return 'missing'
  if (inv.consumed_at) return 'consumed'
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) return 'expired'
  return 'valid'
}

async function ensureCognitoSubForInvite(invite: any): Promise<string | null> {
  const region          = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId      = process.env.VITE_AWS_USER_POOL_ID
  const accessKeyId     = process.env.AWS_ADMIN_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_ADMIN_SECRET_ACCESS_KEY
  if (!userPoolId || !accessKeyId || !secretAccessKey) return null
  const client = new CognitoIdentityProviderClient({ region, credentials: { accessKeyId, secretAccessKey } })
  try {
    const u = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: invite.cognito_username ?? invite.email }))
    const subAttr = u.UserAttributes?.find(a => a.Name === 'sub')
    return subAttr?.Value ?? null
  } catch (e: any) {
    console.error('[onboarding/provider] ensureCognitoSubForInvite failed:', e?.message)
    return null
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    return await handleRequest(req, res)
  } catch (e: any) {
    console.error('[onboarding/provider] uncaught:', e?.stack ?? e?.message ?? e)
    return res.status(500).json({
      error: e?.message ?? 'Internal server error',
      stack: process.env.NODE_ENV === 'production' ? undefined : e?.stack,
    })
  }
}

async function handleRequest(req: VercelRequest, res: VercelResponse) {
  const sql = neon(process.env.DATABASE_URL!)

  if (req.method === 'GET') {
    const token = String((req.query.token as string) ?? '').trim()
    if (!token) return res.status(400).json({ error: 'token required' })
    const inv = await loadInvite(sql, token)
    const state = inviteState(inv)
    if (state === 'missing')  return res.status(404).json({ error: 'Invite not found', state })
    if (state === 'consumed') return res.status(410).json({ error: 'This invite has already been used.', state })
    if (state === 'expired')  return res.status(410).json({ error: 'This invite has expired. Ask your admin to resend.', state })

    // Also pull the practice's available zones + visit types so the
    // wizard can show them for review even if the inviter didn't
    // preset any.
    const [prac] = await sql`SELECT settings FROM practices WHERE id = ${inv.practice_id}::uuid LIMIT 1`
    const practiceSettings = (prac?.settings ?? {}) as any

    return res.status(200).json({
      state: 'valid',
      invite: {
        id:                  inv.id,
        email:               inv.email,
        first_name:          inv.first_name,
        last_name:           inv.last_name,
        role:                inv.role,
        supervising_md_id:   inv.supervising_md_id,
        supervising_md_name: inv.supervising_md_name,
        practice_id:         inv.practice_id,
        practice_name:       inv.practice_name,
        zones:               inv.zones ?? [],
        visit_types:         inv.visit_types ?? [],
        welcome_note:        inv.welcome_note,
        expires_at:          inv.expires_at,
      },
      practice: {
        tax_id:        practiceSettings.tax_id ?? null,
        group_npi:     practiceSettings.group_npi ?? null,
        states:        practiceSettings.states ?? [],
      },
    })
  }

  if (req.method === 'POST') {
    const body = req.body ?? {}
    const token = String(body.token ?? '').trim()
    if (!token) return res.status(400).json({ error: 'token required' })

    const inv = await loadInvite(sql, token)
    const state = inviteState(inv)
    if (state !== 'valid') return res.status(410).json({ error: `Invite is ${state}.`, state })

    // Pull validated wizard fields.
    const npi             = String(body.npi ?? '').trim()
    const taxonomyCode    = String(body.taxonomy_code ?? '').trim() || null
    const deaNumber       = String(body.dea_number ?? '').trim() || null
    const statesLicensed  = Array.isArray(body.states_licensed) ? body.states_licensed.map(String) : []
    const stateLicenses   = (body.state_licenses ?? null)   // optional: { 'NC': { number, expires } }
    const initials        = String(body.initials ?? '').trim() || (inv.first_name[0] + inv.last_name[0]).toUpperCase()
    const avatarColor     = String(body.avatar_color ?? '#EEEDFE').trim()
    const avatarTextColor = String(body.avatar_text_color ?? '#3C3489').trim()
    const bio             = String(body.bio ?? '').trim() || null
    const phone           = String(body.phone ?? '').trim()
    const homeAddress     = String(body.home_address ?? '').trim()
    const dosespotClinicianId = String(body.dosespot_clinician_id ?? '').trim() || null

    if (!npi || !/^\d{10}$/.test(npi)) return res.status(400).json({ error: 'Valid 10-digit NPI required' })
    // Phone + home_address are required — enforce server-side even if
    // the client gate was bypassed. See memory
    // feedback_phone_required_everywhere.md. Sara 2026-11-19.
    if (!phone) return res.status(400).json({ error: 'Phone number is required' })
    if (!homeAddress) return res.status(400).json({ error: 'Home address is required' })

    // Grab the Cognito sub the invite endpoint pre-provisioned.
    const cognitoSub = await ensureCognitoSubForInvite(inv)
    if (!cognitoSub) return res.status(500).json({ error: 'Could not locate the login account. Ask your admin to resend the invite.' })

    // Bootstrap columns the wizard writes to but the providers table
    // doesn't yet have. The existing table is minimal — only name +
    // cognito_sub + role + states[] + zones[] were there pre-onboarding.
    // See memory feedback_verify_db_columns_before_sql.md. Sara 2026-11-19.
    try { await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS first_name text` } catch {}
    try { await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS last_name text` } catch {}
    try { await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS dea_number text` } catch {}
    try { await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS state_licenses jsonb` } catch {}
    try { await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS bio text` } catch {}
    try { await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS supervising_md_id uuid` } catch {}

    // `states` and `zones` are text[] (Postgres ARRAY), not jsonb — pass
    // the JS array directly; Neon's serverless driver converts to
    // array literal. `state_licenses` IS jsonb.
    const statesArr: string[] = statesLicensed
    const zonesArr: string[]  = Array.isArray(inv.zones) ? inv.zones.map(String) : []
    const stateLicensesJson = stateLicenses ? JSON.stringify(stateLicenses) : null

    // If a providers row already exists for this cognito_sub, finalize
    // is idempotent — just link to it. Otherwise insert.
    const [existing] = await sql`SELECT id FROM providers WHERE cognito_sub = ${cognitoSub} LIMIT 1`
    let providerId: string
    if (existing) {
      await sql`
        UPDATE providers SET
          first_name    = ${inv.first_name},
          last_name     = ${inv.last_name},
          name          = ${inv.first_name + ' ' + inv.last_name},
          email         = ${inv.email},
          role          = ${inv.role},
          npi           = ${npi},
          taxonomy_code = ${taxonomyCode},
          dea_number    = ${deaNumber},
          states        = ${statesArr},
          state_licenses = ${stateLicensesJson}::jsonb,
          zones         = ${zonesArr},
          initials      = ${initials},
          avatar_color  = ${avatarColor},
          avatar_text_color = ${avatarTextColor},
          bio           = ${bio},
          phone         = ${phone},
          home_address  = ${homeAddress},
          supervising_md_id = ${inv.supervising_md_id}::uuid,
          dosespot_clinician_id = ${dosespotClinicianId},
          is_active     = true
        WHERE id = ${existing.id}::uuid`
      providerId = existing.id
    } else {
      // Explicit gen_random_uuid() — the prod providers.id column is
      // NOT NULL with no DEFAULT, so the implicit id assignment that
      // worked in the preview branch's test fixture didn't translate
      // to prod. Sara's first-successful-schema-check retry caught it.
      const [row] = await sql`
        INSERT INTO providers (
          id, practice_id, cognito_sub, name, first_name, last_name, email,
          role, npi, taxonomy_code, dea_number, states, state_licenses,
          zones, initials, avatar_color, avatar_text_color, bio, phone, home_address,
          supervising_md_id, dosespot_clinician_id, is_active, is_admin, is_super_admin
        ) VALUES (
          gen_random_uuid(),
          ${inv.practice_id}::uuid, ${cognitoSub},
          ${inv.first_name + ' ' + inv.last_name}, ${inv.first_name}, ${inv.last_name},
          ${inv.email}, ${inv.role}, ${npi}, ${taxonomyCode}, ${deaNumber},
          ${statesArr},
          ${stateLicensesJson}::jsonb,
          ${zonesArr},
          ${initials}, ${avatarColor}, ${avatarTextColor}, ${bio}, ${phone}, ${homeAddress},
          ${inv.supervising_md_id}::uuid, ${dosespotClinicianId},
          true, false, false
        )
        RETURNING id`
      providerId = row.id
    }

    await sql`
      UPDATE provider_invites
      SET consumed_at = NOW(), consumed_by_provider_id = ${providerId}::uuid
      WHERE id = ${inv.id}::uuid`

    return res.status(200).json({
      ok: true,
      provider_id: providerId,
      next: '/login',
    })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
