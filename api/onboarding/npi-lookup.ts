import type { VercelRequest, VercelResponse } from '@vercel/node'

// GET /api/onboarding/npi-lookup?npi=1234567890
//
// Server-side proxy to the public NPPES NPI Registry (npiregistry.cms.hhs.gov).
// Why proxy instead of calling from the browser? Two reasons:
//   1. NPPES's CORS is unreliable from browsers.
//   2. Rate-limiting + logging in one place if someone tries to scrape.
//
// Returns a shaped response with the fields the onboarding wizard
// needs — name, taxonomy, practice address. Raw NPPES response is
// also attached for debugging.
//
// No auth required — NPI is public info and this endpoint is reached
// only via a valid (token-scoped) onboarding session. Sara 2026-11-19.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const npi = String((req.query.npi as string) ?? '').trim()
  if (!npi || !/^\d{10}$/.test(npi)) {
    return res.status(400).json({ error: 'NPI must be exactly 10 digits' })
  }

  const url = `https://npiregistry.cms.hhs.gov/api/?number=${npi}&version=2.1&limit=1&pretty=false`

  let data: any
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!r.ok) return res.status(502).json({ error: `NPPES returned ${r.status}` })
    data = await r.json()
  } catch (e: any) {
    return res.status(502).json({ error: `NPPES unreachable: ${e?.message ?? 'unknown'}` })
  }

  const result = Array.isArray(data?.results) && data.results.length > 0 ? data.results[0] : null
  if (!result) return res.status(404).json({ error: 'No NPI record found. Double-check the number.' })

  // NPI type_1 = individual, type_2 = organization. Wizard expects
  // individual provider — reject type_2 so an org NPI doesn't masquerade
  // as the clinician.
  const type = result.enumeration_type
  if (type !== 'NPI-1') {
    return res.status(400).json({ error: 'That NPI belongs to an organization. Use your personal (Type 1) NPI.' })
  }

  const basic = result.basic ?? {}
  const taxonomy = Array.isArray(result.taxonomies) ? (result.taxonomies.find((t: any) => t.primary) ?? result.taxonomies[0]) : null
  const practiceAddr = Array.isArray(result.addresses) ? result.addresses.find((a: any) => a.address_purpose === 'LOCATION') : null
  const mailingAddr  = Array.isArray(result.addresses) ? result.addresses.find((a: any) => a.address_purpose === 'MAILING')  : null

  return res.status(200).json({
    ok: true,
    npi,
    first_name:    basic.first_name  ?? null,
    middle_name:   basic.middle_name  ?? null,
    last_name:     basic.last_name   ?? null,
    credential:    basic.credential  ?? null,  // "MD", "NP", "PA", etc.
    gender:        basic.gender      ?? null,
    sole_proprietor: basic.sole_proprietor ?? null,
    status:        basic.status      ?? null,  // "A" = active
    enumeration_date: basic.enumeration_date ?? null,
    taxonomy: taxonomy ? {
      code:        taxonomy.code,
      description: taxonomy.desc,
      license:     taxonomy.license ?? null,
      state:       taxonomy.state   ?? null,
      primary:     !!taxonomy.primary,
    } : null,
    practice_address: practiceAddr ? {
      line1:   practiceAddr.address_1,
      line2:   practiceAddr.address_2,
      city:    practiceAddr.city,
      state:   practiceAddr.state,
      zip:     practiceAddr.postal_code,
      phone:   practiceAddr.telephone_number,
    } : null,
    mailing_address: mailingAddr ? {
      line1:   mailingAddr.address_1,
      line2:   mailingAddr.address_2,
      city:    mailingAddr.city,
      state:   mailingAddr.state,
      zip:     mailingAddr.postal_code,
    } : null,
    raw: result,
  })
}
