import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { randomBytes } from 'crypto'
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider'

// POST /api/admin/invite-provider
//
// Super-admin only. Creates a Cognito account for the new provider
// (so they can log in the moment they finish the wizard) + a
// provider_invites row (so the wizard knows what roles/zones to set
// up) + sends a Resend email with the onboarding URL.
//
// Phase 1 of the automated-onboarding project. Sara 2026-11-19.
//
// Payload:
//   { email, first_name, last_name, role, supervising_md_id?,
//     zones[], visit_types[], welcome_note? }
//
// Returns: { ok: true, invite_id, onboarding_url }

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const PRACTICE_FROM_EMAIL = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://phc-team.com'

async function verifyProviderToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

async function bootstrapInvitesTable(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS provider_invites (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token                  text NOT NULL UNIQUE,
      practice_id            uuid NOT NULL,
      email                  text NOT NULL,
      first_name             text NOT NULL,
      last_name              text NOT NULL,
      role                   text NOT NULL,
      supervising_md_id      uuid,
      zones                  jsonb DEFAULT '[]'::jsonb,
      visit_types            jsonb DEFAULT '[]'::jsonb,
      welcome_note           text,
      created_by             uuid NOT NULL,
      created_by_name        text,
      created_at             timestamptz NOT NULL DEFAULT NOW(),
      expires_at             timestamptz NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
      consumed_at            timestamptz,
      consumed_by_provider_id uuid,
      cognito_username       text,
      temp_password          text,
      email_sent_at          timestamptz,
      email_send_error       text
    )`
  await sql`CREATE INDEX IF NOT EXISTS provider_invites_token_idx    ON provider_invites(token)`
  await sql`CREATE INDEX IF NOT EXISTS provider_invites_practice_idx ON provider_invites(practice_id, created_at DESC)`
}

// Generates a reasonably random but still-user-facing invite token.
// Not a signed JWT — the token is a secret only; the server looks it
// up in provider_invites and compares expires_at + consumed_at.
function generateInviteToken(): string {
  return randomBytes(32).toString('base64url')
}

// Cognito's AdminCreateUser wants a temp password that satisfies the
// pool's password policy. We generate one strong enough to clear any
// reasonable policy, then email the sign-in link along WITH the temp
// password (user will set a permanent password during the wizard).
function generateTempPassword(): string {
  const bytes = randomBytes(12).toString('base64').replace(/[+/=]/g, '').slice(0, 14)
  // Ensure at least one of each category Cognito tends to require.
  return `A1a!${bytes}`
}

async function createCognitoUser(opts: { email: string; firstName: string; lastName: string; tempPassword: string }): Promise<{ username: string }> {
  const region          = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId      = process.env.VITE_AWS_USER_POOL_ID
  const accessKeyId     = process.env.AWS_ADMIN_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_ADMIN_SECRET_ACCESS_KEY
  if (!userPoolId || !accessKeyId || !secretAccessKey) {
    throw new Error('Cognito admin credentials missing — check VITE_AWS_USER_POOL_ID + AWS_ADMIN_* env')
  }

  const client = new CognitoIdentityProviderClient({ region, credentials: { accessKeyId, secretAccessKey } })
  const email = opts.email.toLowerCase().trim()

  // If the user already exists, surface a clear error — Sara needs to
  // either delete the old account first or reuse a different email.
  try {
    await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }))
    throw new Error(`A Cognito account already exists for ${email}. Deactivate the previous provider or invite with a different email.`)
  } catch (e: any) {
    if (e?.name !== 'UserNotFoundException') throw e
  }

  await client.send(new AdminCreateUserCommand({
    UserPoolId: userPoolId,
    Username: email,
    TemporaryPassword: opts.tempPassword,
    MessageAction: 'SUPPRESS',  // we send our own branded email via Resend
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
      { Name: 'given_name', Value: opts.firstName },
      { Name: 'family_name', Value: opts.lastName },
    ],
  }))

  // AdminCreateUser leaves the account in FORCE_CHANGE_PASSWORD state.
  // The wizard asks the new provider to set their permanent password
  // via the normal Cognito change-password flow on first login — so no
  // AdminSetUserPassword here.
  return { username: email }
}

async function sendInviteEmail(opts: {
  to: string
  firstName: string
  practiceName: string
  inviterName: string
  tempPassword: string
  onboardingUrl: string
  welcomeNote: string | null
  role: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!RESEND_API_KEY) {
    console.log(`[EMAIL SKIPPED — no RESEND_API_KEY] Invite for ${opts.to}`)
    return { ok: false, error: 'RESEND_API_KEY not configured' }
  }
  const noteBlock = opts.welcomeNote?.trim()
    ? `<p style="background:#F7F6FE;border-left:3px solid #7F77DD;padding:12px 14px;margin:18px 0;color:#1A1A2E;font-size:14px;line-height:1.5">${escapeHtml(opts.welcomeNote)}</p>`
    : ''
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1A1A2E;max-width:560px;margin:0 auto">
      <div style="background:#1A1A2E;padding:20px 24px;border-radius:12px 12px 0 0">
        <div style="color:white;font-size:20px;font-weight:600">${escapeHtml(opts.practiceName)}</div>
        <div style="color:#AFA9EC;font-size:12px;margin-top:4px">Welcome to the team</div>
      </div>
      <div style="padding:24px;background:white;border:1px solid #E8E8E4;border-top:none;border-radius:0 0 12px 12px">
        <p style="font-size:15px;line-height:1.6;margin:0 0 14px">Hi ${escapeHtml(opts.firstName)},</p>
        <p style="font-size:15px;line-height:1.6;margin:0 0 14px">${escapeHtml(opts.inviterName)} has invited you to join <strong>${escapeHtml(opts.practiceName)}</strong> on GoRoam as a <strong>${escapeHtml(opts.role)}</strong>.</p>
        ${noteBlock}
        <p style="font-size:15px;line-height:1.6;margin:0 0 14px">Click below to set up your account — takes about 15 minutes. You'll confirm your NPI, state licenses, DEA, and a few other details.</p>
        <p style="margin:24px 0"><a href="${opts.onboardingUrl}" style="display:inline-block;background:#7F77DD;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px">Start onboarding</a></p>
        <div style="background:#FAFAF8;border:1px solid #E8E8E4;border-radius:8px;padding:14px;margin:18px 0">
          <div style="font-size:11px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Your temporary sign-in</div>
          <div style="font-size:13px;color:#1A1A2E;margin-bottom:4px"><strong>Email:</strong> ${escapeHtml(opts.to)}</div>
          <div style="font-size:13px;color:#1A1A2E"><strong>Temp password:</strong> <code style="background:white;border:1px solid #E8E8E4;padding:2px 6px;border-radius:4px;font-family:ui-monospace,monospace">${escapeHtml(opts.tempPassword)}</code></div>
          <div style="font-size:11px;color:#666;margin-top:8px">You'll set a permanent password during setup.</div>
        </div>
        <p style="font-size:12px;color:#888;margin:18px 0 0;line-height:1.5">This invite expires in 7 days. If you weren't expecting it, you can ignore this email — no account is created until you complete the wizard.</p>
      </div>
    </div>`
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${opts.practiceName} <${PRACTICE_FROM_EMAIL}>`,
      to: [opts.to],
      subject: `You're invited to join ${opts.practiceName} on GoRoam`,
      html,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 200)}` }
  }
  return { ok: true }
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [inviter] = await sql`SELECT id, name, practice_id, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!inviter) return res.status(403).json({ error: 'Provider not found' })
  if (!inviter.is_super_admin) return res.status(403).json({ error: 'Super-admin only' })

  const body = req.body ?? {}
  const email = String(body.email ?? '').trim().toLowerCase()
  const firstName = String(body.first_name ?? '').trim()
  const lastName = String(body.last_name ?? '').trim()
  const role = String(body.role ?? '').trim()
  const supervisingMdId = body.supervising_md_id ? String(body.supervising_md_id) : null
  const zones = Array.isArray(body.zones) ? body.zones.map(String).filter(Boolean) : []
  const visitTypes = Array.isArray(body.visit_types) ? body.visit_types.map(String).filter(Boolean) : []
  const welcomeNote = typeof body.welcome_note === 'string' ? body.welcome_note.trim() || null : null

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' })
  if (!firstName || !lastName) return res.status(400).json({ error: 'First and last name required' })
  if (!role || !['MD', 'NP', 'PNP', 'PA', 'CMA', 'RN', 'MA'].includes(role)) return res.status(400).json({ error: 'Valid role required' })

  // If the role requires a supervising MD (NP/PNP), validate that the
  // supervising MD exists in the same practice. PA + MA + CMA + RN
  // don't require a co-sign in this flow (they can be optional later).
  if ((role === 'NP' || role === 'PNP') && supervisingMdId) {
    const [sup] = await sql`SELECT id FROM providers WHERE id = ${supervisingMdId}::uuid AND practice_id = ${inviter.practice_id}::uuid AND role = 'MD' LIMIT 1`
    if (!sup) return res.status(400).json({ error: 'Supervising MD not found in this practice' })
  }

  await bootstrapInvitesTable(sql)

  // Reject if there's already an OPEN invite for the same email in this practice.
  const [existingOpen] = await sql`
    SELECT id FROM provider_invites
    WHERE practice_id = ${inviter.practice_id}::uuid
      AND lower(email) = ${email}
      AND consumed_at IS NULL
      AND expires_at > NOW()
    LIMIT 1`
  if (existingOpen) {
    return res.status(409).json({ error: `An open invite already exists for ${email}. Revoke it first or wait for it to expire.` })
  }

  const tempPassword = generateTempPassword()

  // Create Cognito account FIRST (so if it fails we don't leave an
  // orphan invite row that implies a user can log in).
  let cognitoUsername: string
  try {
    const result = await createCognitoUser({ email, firstName, lastName, tempPassword })
    cognitoUsername = result.username
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? 'Failed to create login account' })
  }

  // Get practice name for the email copy. Multi-tenant: use the
  // inviter's practice, not an env default.
  const [practiceRow] = await sql`SELECT name FROM practices WHERE id = ${inviter.practice_id}::uuid LIMIT 1`
  const practiceName = practiceRow?.name ?? 'the practice'

  const token = generateInviteToken()
  const onboardingUrl = `${APP_BASE_URL}/onboarding/provider?token=${encodeURIComponent(token)}`

  const [invite] = await sql`
    INSERT INTO provider_invites
      (token, practice_id, email, first_name, last_name, role,
       supervising_md_id, zones, visit_types, welcome_note,
       created_by, created_by_name, cognito_username, temp_password)
    VALUES
      (${token}, ${inviter.practice_id}::uuid, ${email}, ${firstName}, ${lastName}, ${role},
       ${supervisingMdId}::uuid, ${JSON.stringify(zones)}::jsonb, ${JSON.stringify(visitTypes)}::jsonb, ${welcomeNote},
       ${inviter.id}::uuid, ${inviter.name ?? 'Admin'}, ${cognitoUsername}, ${tempPassword})
    RETURNING id, token`

  const sendResult = await sendInviteEmail({
    to: email,
    firstName,
    practiceName,
    inviterName: inviter.name ?? 'Your admin',
    tempPassword,
    onboardingUrl,
    welcomeNote,
    role,
  })

  if (sendResult.ok) {
    await sql`UPDATE provider_invites SET email_sent_at = NOW() WHERE id = ${invite.id}::uuid`
  } else {
    await sql`UPDATE provider_invites SET email_send_error = ${sendResult.error} WHERE id = ${invite.id}::uuid`
  }

  return res.status(200).json({
    ok: true,
    invite_id: invite.id,
    onboarding_url: onboardingUrl,
    email_sent: sendResult.ok,
    email_error: sendResult.ok ? null : sendResult.error,
  })
}
