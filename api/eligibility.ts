import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

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

const PAYER_IDS: Record<string, string> = {
  'bcbs': '560', 'bcbs of nc': '560', 'bcbs nc': '560',
  'blue cross': '560', 'blue cross blue shield': '560', 'blue cross blue shield of nc': '560',
  'aetna': '60054', 'cigna': '62308',
  'united healthcare': '87726', 'united health care': '87726', 'uhc': '87726',
  'umr': '39026', 'humana': '61101',
  'phcs': '52133', 'multiplan': '52133',
  'coventry': '38217', 'select health': '53589',
  'medcost': '56196', 'healthgram': '56162',
  'bright health': '98798', 'bright healthcare': '98798',
}

function resolvePayer(name: string | null): string | null {
  if (!name) return null
  return PAYER_IDS[name.toLowerCase().trim()] ?? null
}

function parseEligibility(data: any) {
  const benefits: any[] = data.benefitsInformation ?? []

  const active = benefits.some((b: any) => b.code === '1') && !benefits.some((b: any) => b.code === '6')

  const planName = data.planInformation?.planDetails
    ?? benefits.find((b: any) => b.code === '1')?.description
    ?? null

  const deducts = benefits.filter((b: any) => b.code === 'C')
  const oops    = benefits.filter((b: any) => b.code === 'G')

  const findAmt = (arr: any[], level: string, period: string) =>
    arr.find((b: any) => b.coverageLevelCode === level && (b.timePeriodQualifier ?? '').toLowerCase().includes(period))?.benefitAmount

  const toNum = (v: string | undefined) => (v != null ? parseFloat(v) : null)

  const copay       = toNum(benefits.find((b: any) => b.code === 'B')?.benefitAmount)
  const coinsurance = toNum(benefits.find((b: any) => b.code === 'A')?.benefitPercent)

  return {
    active,
    planName,
    groupNumber: data.subscriber?.groupNumber ?? null,
    deductible: {
      individual: {
        total:     toNum(findAmt(deducts, 'IND', 'calendar')),
        remaining: toNum(findAmt(deducts, 'IND', 'remaining')),
      },
      family: {
        total:     toNum(findAmt(deducts, 'FAM', 'calendar')),
        remaining: toNum(findAmt(deducts, 'FAM', 'remaining')),
      },
    },
    outOfPocket: {
      individual: {
        total:     toNum(findAmt(oops, 'IND', 'calendar')),
        remaining: toNum(findAmt(oops, 'IND', 'remaining')),
      },
      family: {
        total:     toNum(findAmt(oops, 'FAM', 'calendar')),
        remaining: toNum(findAmt(oops, 'FAM', 'remaining')),
      },
    },
    copay,
    coinsurance,
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try { await verifyToken(req.headers.authorization) } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
  const sql = neon(process.env.DATABASE_URL!)
  const { appointment_id } = req.body ?? {}
  if (!appointment_id) return res.status(400).json({ error: 'appointment_id required' })

  // Find child via encounter note first, then booking request fallback
  let child: any = null

  const [noteRow] = await sql`
    SELECT c.* FROM encounter_notes en
    JOIN children c ON c.id = en.child_id
    WHERE en.appointment_id = ${appointment_id}::uuid
    LIMIT 1`
  if (noteRow) {
    child = noteRow
  } else {
    // Try via booking request reference code in appointment notes
    const [appt] = await sql`SELECT notes FROM appointments WHERE id = ${appointment_id}::uuid`
    const refMatch = (appt?.notes ?? '').match(/Ref: (PUC-\d+)/)
    if (refMatch) {
      const [booking] = await sql`SELECT child_ids FROM booking_requests WHERE reference_code = ${refMatch[1]} LIMIT 1`
      const childId = booking?.child_ids?.[0]
      if (childId) {
        const [c] = await sql`SELECT * FROM children WHERE id = ${childId}::uuid`
        child = c ?? null
      }
    }
  }

  if (!child) return res.status(404).json({ error: 'No patient record found for this appointment.' })
  if (!child.insurance_member_id) return res.status(422).json({ error: 'No insurance information on file for this patient.' })

  const payerName = child.insurance_provider ?? null
  const payerId   = resolvePayer(payerName)
  if (!payerId) return res.status(422).json({ error: `Insurance provider "${payerName}" not recognized. Verify payer name on the patient record.` })

  const [subLast, subFirst] = (child.insurance_subscriber_name ?? ' ').split(', ')
  const subscriberFirst = subFirst || subLast || ''
  const subscriberLast  = subFirst ? subLast : ''

  const payload = {
    controlNumber: Date.now().toString().slice(-9),
    tradingPartnerServiceId: payerId,
    provider: {
      organizationName: process.env.PRACTICE_NAME || 'Pediatric House Calls PLLC',
      npi: process.env.PRACTICE_NPI || '1093250904',
    },
    subscriber: {
      memberId:    child.insurance_member_id,
      firstName:   subscriberFirst,
      lastName:    subscriberLast,
      dateOfBirth: child.insurance_subscriber_dob ? String(child.insurance_subscriber_dob).slice(0, 10).replace(/-/g, '') : '',
    },
    dependent: {
      firstName:        child.first_name ?? '',
      lastName:         child.last_name  ?? '',
      dateOfBirth:      child.date_of_birth ? String(child.date_of_birth).slice(0, 10).replace(/-/g, '') : '',
      relationshipCode: '19',
    },
    encounter: { serviceTypeCodes: ['30'] },
  }

  let stediData: any
  try {
    const stediRes = await fetch(
      'https://healthcare.us.stedi.com/2024-04-01/change/medicalclaims/v3/eligibility',
      {
        method: 'POST',
        headers: {
          'Authorization': `Key ${process.env.STEDI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    )
    stediData = await stediRes.json()
    if (!stediRes.ok) {
      return res.status(422).json({ error: stediData?.message ?? 'Eligibility check failed', details: stediData })
    }
  } catch (err: any) {
    return res.status(500).json({ error: 'Could not reach eligibility service.' })
  }

  return res.json({
    patientName: `${child.first_name ?? ''} ${child.last_name ?? ''}`.trim(),
    insuranceProvider: payerName,
    memberId: child.insurance_member_id,
    ...parseEligibility(stediData),
  })
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Eligibility check error.' })
  }
}
