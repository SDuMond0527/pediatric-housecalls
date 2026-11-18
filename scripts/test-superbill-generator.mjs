// Smoke test for the superbill PDF generator. No DB, no auth. Drives
// buildSuperbillPdf() with synthetic claim data across edge cases and
// verifies each returns a valid %PDF- byte stream of reasonable size.
//
//   node_modules/.bin/tsx scripts/test-superbill-generator.mjs
//
// Sara 2026-11-18.

import { buildSuperbillPdf } from '../api/claims/[id]/superbill-pdf.ts'
import { writeFileSync } from 'node:fs'

const PHC_PRACTICE = {
  name: 'Pediatric House Calls PLLC',
  legalName: 'Pediatric House Calls PLLC',
  tax_id: '81-4038809',
  group_npi: '1093250904',
  address_line1: '123 Main St',
  address_city: 'Cary',
  address_state: 'NC',
  address_zip: '27511',
  main_phone: '(919) 555-0123',
  statement_footer_text: null,
  generates_superbills: true,
}

const BASE_CLAIM = {
  id: '00000000-0000-0000-0000-000000000001',
  practice_id: '00000000-0000-0000-0000-000000000002',
  child_id: '00000000-0000-0000-0000-000000000003',
  patient_profile_id: null,
  service_date: '2026-10-09',
  place_of_service: '12',
  patient_first_name: 'Colin',
  patient_last_name: 'Simpson',
  patient_dob: '2015-06-14',
  patient_address: '456 Oak Ln',
  patient_city: 'Cary',
  patient_state: 'NC',
  patient_zip: '27511',
  subscriber_name: 'Jane Simpson',
  subscriber_dob: '1985-03-20',
  member_id: 'MEM12345',
  group_number: 'GRP7777',
  payer_name: 'Aetna',
  payer_id: '60054',
  cpt_codes: [
    { code: '99213', description: 'Established patient visit — 20 min', charge_amount: 150, units: 1, place_of_service: '12' },
    { code: '94640', description: 'Nebulizer treatment', charge_amount: 45, units: 1, place_of_service: '12' },
  ],
  diagnoses: [
    { code: 'J45.909', description: 'Unspecified asthma, uncomplicated' },
    { code: 'J06.9', description: 'Acute upper respiratory infection, unspecified' },
  ],
  total_charge: 195,
  rendering_provider_name: 'Dr. Sara DuMond, MD',
  rendering_provider_npi: '1376653576',
}

const CASES = [
  {
    name: 'full claim — all fields present',
    claim: BASE_CLAIM,
    amountPaidCents: 19500,
    saveTo: '/tmp/superbill-full.pdf',
  },
  {
    name: 'no subscriber (self-pay)',
    claim: { ...BASE_CLAIM, payer_name: 'Self Pay', payer_id: 'PP', member_id: null, subscriber_name: null, subscriber_dob: null, group_number: null },
    amountPaidCents: 19500,
    saveTo: '/tmp/superbill-selfpay.pdf',
  },
  {
    name: 'no diagnoses',
    claim: { ...BASE_CLAIM, diagnoses: [] },
    amountPaidCents: 19500,
  },
  {
    name: 'no CPTs (shouldnt crash)',
    claim: { ...BASE_CLAIM, cpt_codes: [] },
    amountPaidCents: 0,
  },
  {
    name: 'no address on patient',
    claim: { ...BASE_CLAIM, patient_address: null, patient_city: null, patient_state: null, patient_zip: null },
    amountPaidCents: 19500,
  },
  {
    name: 'no rendering provider NPI',
    claim: { ...BASE_CLAIM, rendering_provider_npi: null },
    amountPaidCents: 19500,
  },
  {
    name: 'balance due remaining',
    claim: BASE_CLAIM,
    amountPaidCents: 10000, // paid 100, charged 195 → balance 95
  },
  {
    name: 'practice with no tax_id/npi (missing identity)',
    claim: BASE_CLAIM,
    amountPaidCents: 19500,
    practice: { ...PHC_PRACTICE, tax_id: null, group_npi: null },
  },
]

let pass = 0, fail = 0
for (const c of CASES) {
  try {
    const bytes = await buildSuperbillPdf({
      claim: c.claim,
      practice: c.practice ?? PHC_PRACTICE,
      amountPaidCents: c.amountPaidCents,
    })
    const magic = Buffer.from(bytes.slice(0, 5)).toString('utf8')
    if (magic !== '%PDF-') throw new Error(`bad magic: ${magic}`)
    if (bytes.length < 1000 || bytes.length > 200_000) throw new Error(`unreasonable size: ${bytes.length} bytes`)
    if (c.saveTo) {
      writeFileSync(c.saveTo, bytes)
      console.log(`✓ ${c.name}  (${bytes.length} bytes, saved ${c.saveTo})`)
    } else {
      console.log(`✓ ${c.name}  (${bytes.length} bytes)`)
    }
    pass++
  } catch (e) {
    console.log(`✗ ${c.name}: ${e.message}`)
    fail++
  }
}
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
console.log(`\nOpen /tmp/superbill-full.pdf to eyeball the full-field layout.`)
console.log(`Open /tmp/superbill-selfpay.pdf to eyeball the self-pay layout.`)
