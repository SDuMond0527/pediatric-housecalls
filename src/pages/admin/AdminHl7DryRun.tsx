import { useState } from 'react'
import { FlaskConical, Play, AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react'
import { hl7DryRun, type Hl7DryRunResponse } from '../../lib/api'

// Super-admin-only. Paste a raw HL7 ORU result message, see what
// GoRoam would parse + which patient it'd match + what results rows
// it would create — all WITHOUT touching the database. Used to
// validate the LabCorp pipeline before go-live. Sara 2026-11-17.

const EXAMPLE = `MSH|^~\\&|LABCORP|32834485|GOROAM|PHC|20260907140530||ORU^R01|MSG12345|P|2.3
PID|1||MRN987^^^LABCORP||DUMOND^CAROLINE||20070504|F|||123 MAIN ST^^CHARLOTTE^NC^28210||704-555-1234
ORC|RE|REQ12345||LAB98765|CM
OBR|1|REQ12345|LAB98765|005009^CBC WITH DIFFERENTIAL^L|||20260907120000||||||||||1376653576^DUMOND^SARA^MD
OBX|1|NM|6690-2^WBC^LN||7.2|10*3/uL|4.0-11.0|N|||F
OBX|2|NM|718-7^HEMOGLOBIN^LN||14.1|g/dL|12.0-16.0|N|||F
OBX|3|NM|787-2^MCV^LN||88.3|fL|80.0-100.0|N|||F
OBX|4|NM|777-3^PLATELET COUNT^LN||265|10*3/uL|150-400|N|||F
NTE|1||All values within normal range. Report finalized 2026-09-07.`

export function AdminHl7DryRun() {
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Hl7DryRunResponse | null>(null)

  async function run() {
    if (!message.trim()) { setError('Paste a message first.'); return }
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const data = await hl7DryRun(message)
      setResult(data)
    } catch (e: any) {
      setError(e?.message ?? 'Dry-run failed')
    } finally { setLoading(false) }
  }

  const match = result?.match as any

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <FlaskConical size={18} className="text-[#7F77DD]" />
          <div>
            <div className="font-display text-[18px] font-medium text-[#1A1A2E]">HL7 dry-run</div>
            <div className="text-[12px] text-[#1A1A2E]/70">Paste a lab result message. See what GoRoam would parse, match, and ingest — nothing writes to the chart.</div>
          </div>
        </div>
      </div>

      <div className="p-6 max-w-5xl space-y-4">
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-4 space-y-3">
          <textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { void run() } }}
            rows={12}
            placeholder="Paste a raw HL7 ORU^R01 message here…"
            className="w-full px-3 py-2 text-[12px] font-mono border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD] resize-y"
          />
          <div className="flex items-center justify-between">
            <button onClick={() => setMessage(EXAMPLE)}
              className="text-[11px] text-[#7F77DD] hover:underline">Load example message</button>
            <button onClick={() => void run()} disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#7F77DD] text-white text-[13px] font-medium rounded-lg hover:bg-[#6B64C8] disabled:opacity-50">
              <Play size={13} /> {loading ? 'Parsing…' : 'Run dry-run'}
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 text-[13px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" /> <span>{error}</span>
          </div>
        )}

        {result && (
          <>
            {/* Warnings */}
            {Array.isArray(result.parsed?.warnings) && result.parsed.warnings.length > 0 && (
              <div className="bg-[#FEF3C7] border border-[#F5B041] rounded-xl p-3">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#78350F] mb-1">
                  <AlertTriangle size={12} /> Parse warnings
                </div>
                <ul className="text-[12px] text-[#78350F] list-disc pl-5 space-y-0.5">
                  {result.parsed.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}

            {/* Patient match */}
            <div className="bg-white border border-[#E8E8E4] rounded-xl p-4">
              <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wide mb-2">Patient match</div>
              {match?.kind === 'exact' && (
                <div className="flex items-center gap-2 text-[13px]">
                  <CheckCircle2 size={14} className="text-[#1D9E75]" />
                  <span><strong>Exact match:</strong> {match.display_name}</span>
                  <code className="text-[11px] text-[#1A1A2E]/60 font-mono">
                    {match.child_id ? `child_id: ${match.child_id}` : `patient_profile_id: ${match.patient_profile_id}`}
                  </code>
                </div>
              )}
              {match?.kind === 'ambiguous' && (
                <>
                  <div className="flex items-center gap-2 text-[13px] text-[#78350F] mb-2">
                    <HelpCircle size={14} />
                    <span>Needs manual review — {match.candidates.length} candidate{match.candidates.length === 1 ? '' : 's'} found.</span>
                  </div>
                  <table className="w-full text-[12px]">
                    <thead className="bg-[#FAFAF8] text-[10px] uppercase text-[#1A1A2E]/60">
                      <tr>
                        <th className="text-left px-2 py-1">Name</th>
                        <th className="text-left px-2 py-1">DOB</th>
                        <th className="text-left px-2 py-1">Phone</th>
                        <th className="text-left px-2 py-1">Score</th>
                        <th className="text-left px-2 py-1">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1EFE8]">
                      {match.candidates.map((c: any, i: number) => (
                        <tr key={i}>
                          <td className="px-2 py-1">{c.first_name} {c.last_name}</td>
                          <td className="px-2 py-1 font-mono">{c.date_of_birth ?? '—'}</td>
                          <td className="px-2 py-1 font-mono">{c.phone ?? '—'}</td>
                          <td className="px-2 py-1 font-mono">{c.score}</td>
                          <td className="px-2 py-1 text-[#1A1A2E]/70">{c.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              {(match?.kind === 'none' || match?.kind === 'skipped') && (
                <div className="flex items-center gap-2 text-[13px] text-[#991B1B]">
                  <AlertTriangle size={14} />
                  <span>{match.kind === 'none' ? 'No match found' : 'Lookup skipped'} — {match.reason}</span>
                </div>
              )}
            </div>

            {/* Proposed rows */}
            <div className="bg-white border border-[#E8E8E4] rounded-xl p-4">
              <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wide mb-2">
                Proposed result{result.proposed_results.length === 1 ? '' : 's'} ({result.proposed_results.length})
              </div>
              <div className="text-[11px] text-[#1A1A2E]/60 mb-3">These would land in the Labs inbox as status=pending_review.</div>
              {result.proposed_results.map((r, i) => (
                <div key={i} className="mb-4 border border-[#E8E8E4] rounded-lg p-3">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <code className="text-[11px] font-mono text-[#3C3489] bg-[#EEEDFE] border border-[#AFA9EC] rounded px-1.5 py-0.5">{r.test_code ?? '—'}</code>
                    <div className="text-[13px] font-medium text-[#1A1A2E]">{r.test_name ?? '(no name)'}</div>
                    <div className="text-[11px] text-[#1A1A2E]/60">
                      {r.source_lab ?? '—'} · specimen {r.specimen_date ?? '—'} · ordered by {r.source_provider ?? '—'}
                    </div>
                  </div>
                  {r.observations.length > 0 && (
                    <table className="w-full text-[12px] mt-2">
                      <thead className="bg-[#FAFAF8] text-[10px] uppercase text-[#1A1A2E]/60">
                        <tr>
                          <th className="text-left px-2 py-1">Test</th>
                          <th className="text-right px-2 py-1">Value</th>
                          <th className="text-left px-2 py-1">Units</th>
                          <th className="text-left px-2 py-1">Reference</th>
                          <th className="text-left px-2 py-1">Flag</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#F1EFE8]">
                        {r.observations.map((o, j) => (
                          <tr key={j} className={o.abnormal_flag && !/^[N]?$/.test(o.abnormal_flag) ? 'bg-[#FCEBEB]' : ''}>
                            <td className="px-2 py-1">{o.name}</td>
                            <td className="px-2 py-1 text-right font-mono">{o.value ?? '—'}</td>
                            <td className="px-2 py-1 font-mono text-[11px]">{o.units ?? ''}</td>
                            <td className="px-2 py-1 font-mono text-[11px]">{o.reference_range ?? ''}</td>
                            <td className="px-2 py-1">
                              {o.abnormal_flag && !/^[N]?$/.test(o.abnormal_flag)
                                ? <span className="inline-block px-1.5 py-0.5 text-[10px] font-semibold rounded bg-[#991B1B] text-white">{o.abnormal_flag}</span>
                                : <span className="text-[#1A1A2E]/40 text-[11px]">normal</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
