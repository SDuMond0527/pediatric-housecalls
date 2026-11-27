import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'
import { statementDedupCheck } from '../../lib/api'

// Admin-only page. Runs the dedup scan with the signed-in session so no
// manual token needed. Shows every claim in the practice that has two
// or more active patient_statements, auto-installs the DB-level lock
// when the list is clean. Sara 2026-11-27 — Eliza / Harrison / probably
// more.

type Row = {
  claim_id: string
  statement_count: number
  statement_ids: string[]
  statuses: string[]
  service_dates: string[]
  amounts: string[]
  patient_name: string | null
}

type Resp = {
  ok: boolean
  lock_installed: boolean
  duplicates_found: number
  duplicates?: Row[]
  message: string
  lock_created_this_call?: boolean
  already_installed?: boolean
}

export function AdminStatementDedupCheck() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [resp, setResp] = useState<Resp | null>(null)

  async function run() {
    setLoading(true)
    setError(null)
    try {
      const r = await statementDedupCheck()
      setResp(r)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { run() }, [])

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#7F77DD]/10 flex items-center justify-center">
            <AlertTriangle size={18} className="text-[#7F77DD]" />
          </div>
          <div>
            <h1 className="font-display text-xl font-semibold text-[#1A1A2E]">Duplicate statement scan</h1>
            <p className="text-[12px] text-[#1A1A2E] mt-0.5">
              Finds any claim that has more than one active (non-voided) patient statement. Installs
              the database-level lock once the list is clean.
            </p>
          </div>
        </div>
        <button
          onClick={run}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#F1EFE8] text-[#555] text-[12px] font-medium rounded-lg hover:bg-[#E8E4D8] disabled:opacity-50">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Re-run scan
        </button>
      </div>

      {loading && <div className="text-[13px] text-[#1A1A2E] py-6">Scanning...</div>}

      {error && !loading && (
        <div className="bg-[#FCEBEB] border border-[#F2B5B5] rounded-xl p-4 text-[13px] text-[#791F1F]">
          <strong>Scan failed:</strong> {error}
        </div>
      )}

      {resp && !loading && !error && resp.duplicates_found === 0 && (
        <div className="bg-[#ECFDF5] border border-[#86E7C4] rounded-xl p-5">
          <div className="flex items-start gap-3">
            <CheckCircle2 size={22} className="text-[#047857] flex-shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-[#065F46] text-[14px] mb-1">No duplicate statements found</div>
              <div className="text-[13px] text-[#065F46]">{resp.message}</div>
              {resp.lock_created_this_call && (
                <div className="text-[12px] text-[#047857] mt-2 font-medium">
                  Lock just installed. Any future race between the ERA webhook, cron poll, or self-pay
                  sign-path will be stopped at the database.
                </div>
              )}
              {resp.already_installed && (
                <div className="text-[12px] text-[#047857] mt-2 font-medium">
                  Lock was already installed from a previous run.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {resp && !loading && !error && resp.duplicates_found > 0 && resp.duplicates && (
        <>
          <div className="bg-[#FEF3C7] border border-[#F7D06A] rounded-xl p-5 mb-5">
            <div className="flex items-start gap-3">
              <AlertTriangle size={22} className="text-[#92400E] flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold text-[#78350F] text-[14px] mb-1">
                  {resp.duplicates_found} claim{resp.duplicates_found === 1 ? '' : 's'} with duplicate active statements
                </div>
                <div className="text-[13px] text-[#78350F]">{resp.message}</div>
                <div className="text-[12px] text-[#92400E] mt-2">
                  For each row below: open <strong>Admin → Patient Statements</strong>, search the patient's
                  name, click <strong>Edit</strong> on all but one of their duplicate rows, hit <strong>Write
                  off</strong> with reason <em>Billing error</em>. Re-run this scan when you're done; the DB
                  lock installs automatically once the list hits zero.
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
            <table className="w-full text-[13px]">
              <thead className="bg-[#FAFAF8] text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3 text-left">Patient</th>
                  <th className="px-4 py-3 text-left">Date of service</th>
                  <th className="px-4 py-3 text-left">Count</th>
                  <th className="px-4 py-3 text-left">Amounts</th>
                  <th className="px-4 py-3 text-left">Statuses</th>
                  <th className="px-4 py-3 text-left">Claim ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F1EFE8]">
                {resp.duplicates.map(d => {
                  const dates = Array.from(new Set(d.service_dates.map(x => String(x).slice(0, 10))))
                  return (
                    <tr key={d.claim_id} className="hover:bg-[#FAFAF8]">
                      <td className="px-4 py-3 font-medium text-[#1A1A2E]">{d.patient_name ?? '—'}</td>
                      <td className="px-4 py-3 text-[#555] tabular-nums">{dates.join(', ')}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#FEE2E2] text-[#7F1D1D]">
                          {d.statement_count}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-[#555] tabular-nums">
                        {d.amounts.map(a => `$${parseFloat(String(a ?? '0')).toFixed(2)}`).join(', ')}
                      </td>
                      <td className="px-4 py-3 text-[#555] text-[12px]">{d.statuses.join(', ')}</td>
                      <td className="px-4 py-3 text-[11px] text-[#666] font-mono">{d.claim_id.slice(0, 8)}…</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
