import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { buildOrderPdf } from './email'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

/**
 * GET /api/radiology/[id]/pdf — build the order PDF and return it as
 * base64 plain text (sidesteps Vercel's buffer-corruption pattern — see
 * the matching trick in api/claims/[id]/1500-pdf.ts). The client
 * decodes and triggers a browser download.
 *
 * Shares the PDF builder with the email flow by importing from ./email,
 * so the downloaded file is byte-for-byte identical to what the family
 * receives in their inbox.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).send('ERR: method not allowed')

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).send('ERR: unauthorized') }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).send('ERR: provider not found')

  const orderId = req.query.id as string
  if (!orderId) return res.status(400).send('ERR: order id required')

  try {
    const [order] = await sql`
      SELECT
        o.id, o.tests, o.diagnoses, o.priority, o.notes, o.created_at,
        p.name AS provider_name, p.role AS provider_role, p.npi AS provider_npi,
        ch.first_name AS child_first_name, ch.last_name AS child_last_name,
        ch.date_of_birth AS patient_dob, ch.gender AS patient_gender,
        ch.insurance_provider,
        ch.insurance_member_id, ch.insurance_group_number,
        ch.insurance_subscriber_name, ch.insurance_subscriber_dob, ch.insurance_subscriber_gender,
        COALESCE(fp.phone, ch.parent_phone) AS patient_phone,
        COALESCE(fp.email, ch.parent_email) AS family_email,
        fp.address_line1 AS patient_address,
        fp.city AS patient_city, fp.state AS patient_state, fp.zip AS patient_zip
      FROM radiology_orders o
      JOIN providers p ON p.id = o.provider_id AND p.practice_id = ${provider.practice_id}::uuid
      JOIN children ch ON ch.id = o.child_id
      LEFT JOIN family_profiles fp ON fp.id = ch.family_id
      WHERE o.id = ${orderId}::uuid`
    if (!order) return res.status(404).send('ERR: order not found')

    const orderedDate = new Date(order.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    const pdfBytes = await buildOrderPdf({
      patientFirstName:  order.child_first_name ?? '',
      patientLastName:   order.child_last_name ?? '',
      patientDob:        order.patient_dob ?? null,
      patientGender:     order.patient_gender ?? null,
      patientPhone:      order.patient_phone ?? null,
      patientEmail:      order.family_email ?? null,
      patientAddress:    order.patient_address ?? null,
      patientCity:       order.patient_city ?? null,
      patientState:      order.patient_state ?? null,
      patientZip:        order.patient_zip ?? null,
      insuranceProvider: order.insurance_provider ?? null,
      memberId:          order.insurance_member_id ?? null,
      groupNumber:       order.insurance_group_number ?? null,
      subscriberName:    order.insurance_subscriber_name ?? null,
      subscriberDob:     order.insurance_subscriber_dob ?? null,
      subscriberGender:  order.insurance_subscriber_gender ?? null,
      providerName:      order.provider_name,
      providerRole:      order.provider_role ?? null,
      providerNpi:       order.provider_npi ?? null,
      orderedDate,
      tests:             Array.isArray(order.tests) ? order.tests : [],
      diagnoses:         Array.isArray(order.diagnoses) ? order.diagnoses : [],
      priority:          order.priority ?? 'routine',
      notes:             order.notes ?? null,
    })

    const base64 = Buffer.from(pdfBytes).toString('base64')
    const patientSlug = [order.child_first_name, order.child_last_name]
      .filter(Boolean).join('-').replace(/[^\w\-]+/g, '').toLowerCase() || 'patient'
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('X-PDF-Filename', `radiology-order-${patientSlug}-${orderId.slice(0, 8)}.pdf`)
    return res.status(200).send(base64)
  } catch (e: any) {
    console.error('radiology/[id]/pdf error:', e)
    return res.status(500).send(`ERR: ${e?.message ?? 'internal'}`)
  }
}
