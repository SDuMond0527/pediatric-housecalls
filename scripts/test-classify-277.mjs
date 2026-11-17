// Standalone test of the classify277() bucket logic. Walks a handful
// of synthetic 277 responses through the classifier and asserts the
// bucket. No DB, no Stedi call. Run:
//   node scripts/test-classify-277.mjs
//
// Sara 2026-11-17.

import { classify277 } from '../api/stedi/claim-status.js'

const CASES = [
  {
    name: 'Rejected at intake (CSCC A3)',
    input: { claimInformation: { statusInformation: [{ categoryCode: 'A3', statusCode: '21', statusCodeDescription: 'Missing or invalid info' }] } },
    expect: 'rejected_intake',
  },
  {
    name: 'Not on file (CSCC D0)',
    input: { claimInformation: { statusInformation: [{ categoryCode: 'D0', statusCode: '35', statusCodeDescription: 'Claim/encounter not found' }] } },
    expect: 'not_on_file',
  },
  {
    name: 'Not on file (status code 35 only)',
    input: { claimInformation: { statusInformation: [{ categoryCode: 'A1', statusCode: '35', statusCodeDescription: 'Claim/encounter not found' }] } },
    expect: 'not_on_file',
  },
  {
    name: 'Finalized paid (CSCC F1)',
    input: { claimInformation: { statusInformation: [{ categoryCode: 'F1', statusCode: '65', statusCodeDescription: 'Claim/line has been paid.' }] } },
    expect: 'era_pending',
  },
  {
    name: 'Pending in process (CSCC P1)',
    input: { claimInformation: { statusInformation: [{ categoryCode: 'P1', statusCode: '20', statusCodeDescription: 'Accepted for processing.' }] } },
    expect: 'pending',
  },
  {
    name: 'Acknowledged (CSCC A2) → pending',
    input: { claimInformation: { statusInformation: [{ categoryCode: 'A2', statusCode: '20', statusCodeDescription: 'Accepted for processing' }] } },
    expect: 'pending',
  },
  {
    name: 'Nested payers path (rejection in deep tree)',
    input: {
      payers: [{
        claimStatusTransactions: [{
          claimStatusDetails: [{
            claims: [{ claimStatus: { categoryCode: 'A7', statusCode: '116', statusCodeDescription: 'Claim submitted to wrong payer.' } }],
          }],
        }],
      }],
    },
    expect: 'rejected_intake',
  },
  {
    name: 'Empty response',
    input: {},
    expect: 'unknown',
  },
  {
    name: 'Rejected trumps pending when both appear',
    input: { claimInformation: { statusInformation: [
      { categoryCode: 'A3', statusCode: '21', statusCodeDescription: 'Missing info' },
      { categoryCode: 'P1', statusCode: '20', statusCodeDescription: 'In process' },
    ] } },
    expect: 'rejected_intake',
  },
]

let pass = 0, fail = 0
for (const c of CASES) {
  const got = classify277(c.input)
  const ok = got.bucket === c.expect
  if (ok) pass++; else fail++
  console.log(`${ok ? '✓' : '✗'} ${c.name}  →  ${got.bucket}  ${ok ? '' : `(expected ${c.expect})`}`)
}
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
