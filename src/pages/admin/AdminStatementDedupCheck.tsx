import { useEffect, useState } from 'react'
import { statementDedupCheck } from '../../lib/api'

// Deliberately minimal — no icon imports, no Tailwind, no ternaries
// across complex trees. Inline styles only so a bad CSS import or
// missing lucide module cannot blank the page. Sara 2026-11-27 — the
// previous richer version returned blank on her machine and I need
// something that cannot fail to render.

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

const wrap: React.CSSProperties = { padding: 24, fontFamily: 'system-ui, -apple-system, sans-serif', maxWidth: 1100, margin: '0 auto' }
const h1:   React.CSSProperties = { fontSize: 22, fontWeight: 600, marginBottom: 4, color: '#1A1A2E' }
const sub:  React.CSSProperties = { fontSize: 13, color: '#555', marginBottom: 20 }
const btn:  React.CSSProperties = { padding: '8px 14px', background: '#F1EFE8', color: '#1A1A2E', border: '1px solid #E8E8E4', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 500 }
const box:  React.CSSProperties = { padding: 16, borderRadius: 12, marginBottom: 16, fontSize: 14 }
const okBox:   React.CSSProperties = { ...box, background: '#ECFDF5', border: '1px solid #86E7C4', color: '#065F46' }
const warnBox: React.CSSProperties = { ...box, background: '#FEF3C7', border: '1px solid #F7D06A', color: '#78350F' }
const errBox:  React.CSSProperties = { ...box, background: '#FCEBEB', border: '1px solid #F2B5B5', color: '#791F1F' }
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', background: 'white', border: '1px solid #E8E8E4', borderRadius: 12, overflow: 'hidden', fontSize: 13 }
const th:    React.CSSProperties = { textAlign: 'left', padding: '10px 14px', background: '#FAFAF8', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#1A1A2E', borderBottom: '1px solid #E8E8E4' }
const td:    React.CSSProperties = { padding: '10px 14px', borderBottom: '1px solid #F1EFE8', verticalAlign: 'top' }
const mono:  React.CSSProperties = { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#666' }

export function AdminStatementDedupCheck() {
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [resp, setResp]       = useState<Resp | null>(null)

  async function run() {
    setLoading(true); setError(null)
    try {
      const r = await statementDedupCheck()
      setResp(r)
    } catch (e: any) {
      setError(e?.message ? String(e.message) : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { run() }, [])

  return (
    <div style={wrap}>
      <h1 style={h1}>Duplicate statement scan</h1>
      <div style={sub}>
        Finds every claim in your practice with two or more active statements. Installs the database lock automatically once the list is clean.
      </div>
      <div style={{ marginBottom: 20 }}>
        <button style={btn} onClick={run} disabled={loading}>
          {loading ? 'Scanning…' : 'Re-run scan'}
        </button>
      </div>

      {loading && <div style={box}>Scanning…</div>}

      {!loading && error && (
        <div style={errBox}>
          <strong>Scan failed:</strong> {error}
        </div>
      )}

      {!loading && !error && resp && resp.duplicates_found === 0 && (
        <div style={okBox}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>No duplicate statements found.</div>
          <div>{resp.message}</div>
        </div>
      )}

      {!loading && !error && resp && resp.duplicates_found > 0 && (
        <>
          <div style={warnBox}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {resp.duplicates_found} claim{resp.duplicates_found === 1 ? '' : 's'} with duplicate active statements
            </div>
            <div>{resp.message}</div>
            <div style={{ marginTop: 8, fontSize: 12 }}>
              For each row: Admin → Patient Statements → search the patient → open each duplicate row → Write off → reason "Billing error". Re-run this scan when you're done.
            </div>
          </div>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Patient</th>
                <th style={th}>Date of service</th>
                <th style={th}>Count</th>
                <th style={th}>Amounts</th>
                <th style={th}>Statuses</th>
                <th style={th}>Claim</th>
              </tr>
            </thead>
            <tbody>
              {(resp.duplicates ?? []).map(d => {
                const dates   = Array.isArray(d.service_dates) ? Array.from(new Set(d.service_dates.map(x => String(x ?? '').slice(0, 10)))) : []
                const amounts = Array.isArray(d.amounts) ? d.amounts.map(a => `$${(parseFloat(String(a ?? '0')) || 0).toFixed(2)}`) : []
                const statuses = Array.isArray(d.statuses) ? d.statuses : []
                return (
                  <tr key={d.claim_id}>
                    <td style={td}>{d.patient_name ?? '—'}</td>
                    <td style={td}>{dates.join(', ') || '—'}</td>
                    <td style={td}><strong>{d.statement_count}</strong></td>
                    <td style={td}>{amounts.join(', ') || '—'}</td>
                    <td style={td}>{statuses.join(', ') || '—'}</td>
                    <td style={{ ...td, ...mono }}>{String(d.claim_id ?? '').slice(0, 8)}…</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
