// Patient matcher — takes a parsed PID + practice context, finds the
// right GoRoam patient record (children or patient_profiles). Returns
// a decision + candidates so the dry-run UI can surface ambiguity
// without silently guessing. Sara 2026-11-17.

import type { ParsedPatient } from './parser.js'

export type MatchDecision =
  | { kind: 'exact';     child_id: string | null; patient_profile_id: string | null; display_name: string }
  | { kind: 'ambiguous'; candidates: Candidate[] }
  | { kind: 'none';      reason: string }

export interface Candidate {
  child_id: string | null
  patient_profile_id: string | null
  first_name: string | null
  last_name: string | null
  date_of_birth: string | null
  phone: string | null
  score: number
  reason: string
}

function normalizeName(s: string | null): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function sameDob(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  // Normalize to YYYY-MM-DD (strip time + separators).
  const na = String(a).slice(0, 10).replace(/[^0-9]/g, '')
  const nb = String(b).slice(0, 10).replace(/[^0-9]/g, '')
  return na === nb && na.length === 8
}

export async function matchPatient(
  sql: any,
  practiceId: string,
  pid: ParsedPatient,
): Promise<MatchDecision> {
  if (!pid.firstName && !pid.lastName) {
    return { kind: 'none', reason: 'PID had no first or last name' }
  }

  // 1. Exact match on normalized name + DOB across both patient models.
  //    This is the only tier we treat as fully-trusted.
  const nameLast  = normalizeName(pid.lastName)
  const nameFirst = normalizeName(pid.firstName)
  const dobYmd    = pid.dateOfBirth ? pid.dateOfBirth.slice(0, 10) : null

  if (nameLast && nameFirst && dobYmd) {
    const exact = await sql`
      SELECT 'children' AS tbl, id, first_name, last_name,
             date_of_birth::text AS date_of_birth, parent_phone AS phone
      FROM children
      WHERE practice_id = ${practiceId}::uuid
        AND lower(first_name) = ${nameFirst}
        AND lower(last_name)  = ${nameLast}
        AND date_of_birth = ${dobYmd}::date
      UNION ALL
      SELECT 'patient_profiles' AS tbl, id, first_name, last_name,
             date_of_birth::text AS date_of_birth, phone
      FROM patient_profiles
      WHERE practice_id = ${practiceId}::uuid
        AND lower(first_name) = ${nameFirst}
        AND lower(last_name)  = ${nameLast}
        AND date_of_birth = ${dobYmd}::date`
    if (exact.length === 1) {
      const row = exact[0] as any
      return {
        kind: 'exact',
        child_id:           row.tbl === 'children'         ? row.id : null,
        patient_profile_id: row.tbl === 'patient_profiles' ? row.id : null,
        display_name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
      }
    }
    if (exact.length > 1) {
      // Two records with the same name + DOB — shouldn't happen but
      // let the human pick.
      return {
        kind: 'ambiguous',
        candidates: (exact as any[]).map(r => ({
          child_id:           r.tbl === 'children'         ? r.id : null,
          patient_profile_id: r.tbl === 'patient_profiles' ? r.id : null,
          first_name: r.first_name, last_name: r.last_name,
          date_of_birth: r.date_of_birth, phone: r.phone,
          score: 100,
          reason: 'Exact name + DOB match (duplicate)',
        })),
      }
    }
  }

  // 2. Fuzzy match — name only (no DOB) OR DOB only (no matching name).
  //    Scored candidates returned for human review.
  const candidates: Candidate[] = []

  if (nameLast) {
    const nameMatches = await sql`
      SELECT 'children' AS tbl, id, first_name, last_name,
             date_of_birth::text AS date_of_birth, parent_phone AS phone
      FROM children
      WHERE practice_id = ${practiceId}::uuid
        AND lower(last_name) = ${nameLast}
      UNION ALL
      SELECT 'patient_profiles' AS tbl, id, first_name, last_name,
             date_of_birth::text AS date_of_birth, phone
      FROM patient_profiles
      WHERE practice_id = ${practiceId}::uuid
        AND lower(last_name) = ${nameLast}
      LIMIT 25`

    for (const r of nameMatches as any[]) {
      let score = 50
      const reasons: string[] = ['Same last name']
      if (nameFirst && normalizeName(r.first_name).startsWith(nameFirst.slice(0, 3))) {
        score += 20
        reasons.push('First name prefix match')
      }
      if (sameDob(r.date_of_birth, dobYmd)) {
        score += 30
        reasons.push('DOB match')
      }
      candidates.push({
        child_id:           r.tbl === 'children'         ? r.id : null,
        patient_profile_id: r.tbl === 'patient_profiles' ? r.id : null,
        first_name: r.first_name, last_name: r.last_name,
        date_of_birth: r.date_of_birth, phone: r.phone,
        score,
        reason: reasons.join(' · '),
      })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  const top = candidates.slice(0, 5)

  if (top.length === 0) {
    return { kind: 'none', reason: 'No patients with matching last name on this practice' }
  }

  return { kind: 'ambiguous', candidates: top }
}
