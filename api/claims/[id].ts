import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from '../_lib/db'
import { getProviderContext } from '../_lib/auth'

const PRACTICE_NAME = process.env.PRACTICE_NAME || 'Pediatric House Calls PLLC'
const PRACTICE_NPI  = process.env.PRACTICE_NPI  || '1093250904'
const PRACTICE_TAX  = (process.env.PRACTICE_TAX_ID || '814038809').replace('-', '')
const PRACTICE_ADDR = process.env.PRACTICE_ADDRESS || ''
const PRACTICE_CITY = process.env.PRACTICE_CITY  || 'Charlotte'
const PRACTICE_STATE = process.env.PRACTICE_STATE || 'NC'
const PRACTICE_ZIP  = process.env.PRACTICE_ZIP   || '28202'
const PRACTICE_PHONE = (process.env.PRACTICE_PHONE || '7045550000').replace(/\D/g, '')

function buildStediPayload(claim: any): object {
  const diagnoses = Array.isArray(claim.diagnoses) ? claim.diagnoses : []
  const cptCodes  = Array.isArray(claim.cpt_codes)  ? claim.cpt_codes  : []

  const diagnosisCodes = diagnoses.map((d: any, i: number) => ({
    qualifierCode: i === 0 ? 'ABK' : 'ABF',
    value: d.code,
  }))

  const isTelehealth = (claim.place_of_service ?? '12') === '10'

  const serviceLines = cptCodes.map((c: any) => ({
    serviceDate: (claim.service_date ?? '').replace(/-/g, ''),
    professionalService: {
      procedureIdentifier: 'HC',
      procedureCode: c.code,
      ...(isTelehealth ? { procedureModifiers: ['95'] } : {}),
      lineItemChargeAmount: parseFloat(c.charge_amount ?? 0).toFixed(2),
      measurementUnit: 'UN',
      serviceUnitCount: '1',
      placeOfServiceCode: claim.place_of_service ?? '12',
    },
    diagnosisCodePointers: { pointers: diagnoses.map((_: any, i: number) => String(i + 1)) },
  }))

  const [subLast, subFirst] = (claim.subscriber_name ?? ' ').split(', ')
  const subFirstName = subFirst || subLast
  const subLastName  = subFirst ? subLast : ''

  const providerParts = (claim.rendering_provider_name ?? '').split(' ')
  const provFirst = providerParts[0] ?? ''
  const provLast  = providerParts.slice(1).join(' ') || provFirst

  return {
    tradingPartnerServiceId: claim.payer_id ?? '',
    submitter: {
      organizationName: PRACTICE_NAME,
      contactInformation: { name: 'Billing', phoneNumber: PRACTICE_PHONE },
    },
    receiver: { organizationName: claim.payer_name ?? '' },
    subscriber: {
      memberId: claim.member_id ?? '',
      paymentResponsibilityLevelCode: 'P',
      firstName: subFirstName,
      lastName: subLastName,
      gender: claim.subscriber_gender === 'Female' ? 'F' : claim.subscriber_gender === 'Male' ? 'M' : 'U',
      dateOfBirth: (claim.subscriber_dob ?? '').replace(/-/g, ''),
      groupNumber: claim.group_number ?? '',
      claimFilingCode: 'CI',
    },
    dependent: {
      firstName: claim.patient_first_name ?? '',
      lastName:  claim.patient_last_name  ?? '',
      gender: claim.patient_gender === 'Female' ? 'F' : claim.patient_gender === 'Male' ? 'M' : 'U',
      dateOfBirth: (claim.patient_dob ?? '').replace(/-/g, ''),
      relationshipCode: '19',
      ...(claim.patient_address ? {
        address: {
          address1: claim.patient_address,
          ...(claim.patient_city ? { city: claim.patient_city } : {}),
          state: claim.patient_state ?? '',
          postalCode: (claim.patient_zip ?? '').replace(/\D/g, '').slice(0, 9),
        },
      } : {}),
    },
    providers: [
      {
        providerType: 'BillingProvider',
        npi: PRACTICE_NPI,
        employerId: PRACTICE_TAX,
        organizationName: PRACTICE_NAME,
        address: {
          address1: PRACTICE_ADDR,
          city: PRACTICE_CITY,
          state: PRACTICE_STATE,
          postalCode: PRACTICE_ZIP,
        },
      },
      {
        providerType: 'RenderingProvider',
        npi: claim.rendering_provider_npi ?? '',
        firstName: provFirst,
        lastName: provLast,
        taxonomyCode: claim.rendering_provider_taxonomy ?? '',
      },
    ],
    claimInformation: {
      claimFilingIndicatorCode: 'CI',
      patientControlNumber: claim.id,
      claimChargeAmount: parseFloat(claim.total_charge ?? 0).toFixed(2),
      placeOfServiceCode: claim.place_of_service ?? '12',
      claimFrequencyCode: '1',
      signatureIndicator: 'Y',
      planParticipationCode: 'A',
      benefitsAssignmentCertificationIndicator: 'Y',
      releaseInformationCode: 'Y',
      diagnosisCodes,
      serviceLines,
    },
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let practiceId: string
  try {
    const ctx = await getProviderContext(req.headers.authorization)
    practiceId = ctx.practiceId
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { id } = req.query as Record<string, string>
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'GET') {
    const [claim] = await sql`SELECT * FROM claims WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
    return res.json(claim ?? null)
  }

  if (req.method === 'PUT') {
    const { action, ...fields } = req.body ?? {}

    // Submit to Stedi
    if (action === 'submit') {
      const [claim] = await sql`SELECT * FROM claims WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
      if (!claim) return res.status(404).json({ error: 'Claim not found' })
      if (claim.status === 'submitted') return res.status(400).json({ error: 'Already submitted' })
      if (!claim.payer_id) return res.status(400).json({ error: 'No payer ID — cannot submit. Verify payer and update claim.' })

      const payload = buildStediPayload(claim)

      let stediData: any
      try {
        const stediRes = await fetch(
          'https://healthcare.us.stedi.com/2024-04-01/change/medicalclaims/v3/claims',
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
          const [updated] = await sql`
            UPDATE claims SET
              status = 'error',
              stedi_response = ${JSON.stringify(stediData)}::jsonb,
              submission_error = ${JSON.stringify(stediData)},
              updated_at = now()
            WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid RETURNING *`
          return res.status(422).json({ error: 'Stedi rejected the claim', details: stediData, claim: updated })
        }
      } catch (err: any) {
        const [updated] = await sql`
          UPDATE claims SET status = 'error', submission_error = ${err.message}, updated_at = now()
          WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid RETURNING *`
        return res.status(500).json({ error: 'Failed to reach Stedi', claim: updated })
      }

      const claimId = stediData?.claimReference?.referenceNumber ?? stediData?.id ?? null
      const [updated] = await sql`
        UPDATE claims SET
          status = 'submitted',
          stedi_claim_id = ${claimId},
          stedi_response = ${JSON.stringify(stediData)}::jsonb,
          submission_error = NULL,
          submitted_at = now(),
          updated_at = now()
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid RETURNING *`
      return res.json(updated)
    }

    // General field update (payer_id, payer_name, notes, etc.)
    const allowed = ['payer_name', 'payer_id', 'member_id', 'group_number',
                     'subscriber_name', 'subscriber_dob', 'subscriber_gender',
                     'patient_first_name', 'patient_last_name', 'patient_dob', 'patient_gender',
                     'rendering_provider_npi', 'rendering_provider_taxonomy',
                     'place_of_service', 'service_date', 'status']
    const updates: Record<string, any> = {}
    for (const key of allowed) {
      if (key in fields) updates[key] = fields[key]
    }

    const [updated] = await sql`
      UPDATE claims SET
        payer_name                 = COALESCE(${updates.payer_name ?? null}, payer_name),
        payer_id                   = COALESCE(${updates.payer_id ?? null}, payer_id),
        member_id                  = COALESCE(${updates.member_id ?? null}, member_id),
        group_number               = COALESCE(${updates.group_number ?? null}, group_number),
        subscriber_name            = COALESCE(${updates.subscriber_name ?? null}, subscriber_name),
        subscriber_dob             = COALESCE(${updates.subscriber_dob ?? null}::date, subscriber_dob),
        subscriber_gender          = COALESCE(${updates.subscriber_gender ?? null}, subscriber_gender),
        patient_first_name         = COALESCE(${updates.patient_first_name ?? null}, patient_first_name),
        patient_last_name          = COALESCE(${updates.patient_last_name ?? null}, patient_last_name),
        patient_dob                = COALESCE(${updates.patient_dob ?? null}::date, patient_dob),
        patient_gender             = COALESCE(${updates.patient_gender ?? null}, patient_gender),
        rendering_provider_npi     = COALESCE(${updates.rendering_provider_npi ?? null}, rendering_provider_npi),
        rendering_provider_taxonomy = COALESCE(${updates.rendering_provider_taxonomy ?? null}, rendering_provider_taxonomy),
        place_of_service           = COALESCE(${updates.place_of_service ?? null}, place_of_service),
        service_date               = COALESCE(${updates.service_date ?? null}::date, service_date),
        status                     = COALESCE(${updates.status ?? null}, status),
        updated_at                 = now()
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid RETURNING *`
    return res.json(updated)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
