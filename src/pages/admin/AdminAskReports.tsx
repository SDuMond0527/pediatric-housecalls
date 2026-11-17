import { useEffect, useState } from 'react'
import { Sparkles, Play, Code, Download, AlertTriangle } from 'lucide-react'
import { runReportQuery, type ReportResult } from '../../lib/api'

// Ad-hoc natural-language reports. Admin types a question, Claude
// Sonnet translates it to a SELECT against the practice's data,
// server validates + executes, we render the table + CSV export.
// Sara 2026-11-16 — available to every practice.

const EXAMPLES = [
  'How many patients did I see last month?',
  'List all pending patient callbacks sorted by how long they\'ve been waiting.',
  'Show me every statement that\'s been sent but not paid, oldest first.',
  'Which CPT codes did I bill most this quarter, by total charges?',
  'Give me patients whose last visit was more than a year ago.',
  'How many pathology results came back with a positive margin this year?',
]

const HISTORY_KEY = 'goroam.askreports.history.v1'

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as string[] } catch { return [] }
}
function saveHistory(items: string[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 20))) } catch {}
}

function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const esc = (v: unknown) => {
    if (v == null) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }
  const header = columns.map(esc).join(',')
  const body = rows.map(r => columns.map(c => esc(r[c])).join(',')).join('\n')
  return header + '\n' + body
}

export function AdminAskReports() {
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showSql, setShowSql] = useState(false)
  const [result, setResult] = useState<ReportResult | null>(null)
  const [history, setHistory] = useState<string[]>([])

  useEffect(() => { setHistory(loadHistory()) }, [])

  async function run(q?: string) {
    const prompt = (q ?? question).trim()
    if (!prompt) { setError('Type a question first.'); return }
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const data = await runReportQuery(prompt)
      setResult(data)
      // Push to history
      const next = [prompt, ...history.filter(h => h !== prompt)].slice(0, 20)
      setHistory(next)
      saveHistory(next)
    } catch (e: any) {
      // Server returns {error, sql?} shapes for validation failures.
      const msg = e?.message ?? 'Report failed'
      setError(msg)
      // If the error payload included generated SQL, surface it so the
      // user can see what Claude tried.
      try {
        const parsed = JSON.parse(e?.message ?? '{}')
        if (parsed?.sql) setResult({ sql: parsed.sql, columns: [], rows: [], row_count: 0 })
      } catch {}
    } finally { setLoading(false) }
  }

  function downloadCsv() {
    if (!result) return
    const csv = toCsv(result.rows, result.columns)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `goroam-report-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <Sparkles size={18} className="text-[#7F77DD]" />
          <div>
            <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Ask reports</div>
            <div className="text-[12px] text-[#1A1A2E]/70">Type a question in plain English — Claude writes the query against your practice's data.</div>
          </div>
        </div>
      </div>

      <div className="p-6 max-w-5xl space-y-4">
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-4 space-y-3">
          <textarea
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { void run() } }}
            rows={3}
            placeholder="e.g. Show me every patient who had a biopsy last month and I haven't called back yet."
            className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD] resize-none"
          />
          <div className="flex items-center justify-between">
            <div className="text-[11px] text-[#1A1A2E]/60">Cmd+Enter to run · read-only · scoped to this practice</div>
            <button onClick={() => void run()} disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#7F77DD] text-white text-[13px] font-medium rounded-lg hover:bg-[#6B64C8] disabled:opacity-50">
              <Play size={13} /> {loading ? 'Running…' : 'Run report'}
            </button>
          </div>
        </div>

        {/* Quick-pick examples */}
        {!result && !loading && (
          <div className="bg-[#FAFAF8] border border-[#E8E8E4] rounded-xl p-4">
            <div className="text-[11px] font-semibold text-[#1A1A2E]/70 uppercase tracking-wide mb-2">Try an example</div>
            <div className="space-y-1">
              {EXAMPLES.map(ex => (
                <button key={ex}
                  onClick={() => { setQuestion(ex); void run(ex) }}
                  className="block w-full text-left px-3 py-1.5 text-[12px] text-[#3C3489] bg-white border border-[#E8E8E4] rounded-lg hover:bg-[#EEEDFE]">
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* History */}
        {history.length > 0 && (
          <div className="bg-[#FAFAF8] border border-[#E8E8E4] rounded-xl p-4">
            <div className="text-[11px] font-semibold text-[#1A1A2E]/70 uppercase tracking-wide mb-2">Recent questions</div>
            <div className="space-y-1">
              {history.map(h => (
                <button key={h}
                  onClick={() => { setQuestion(h); void run(h) }}
                  className="block w-full text-left px-3 py-1.5 text-[12px] text-[#1A1A2E] bg-white border border-[#E8E8E4] rounded-lg hover:bg-[#F1EFE8]">
                  {h}
                </button>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 text-[13px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" /> <span>{error}</span>
          </div>
        )}

        {result && (
          <div className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E8E8E4] flex items-center justify-between">
              <div className="text-[12px] text-[#1A1A2E]">
                <strong>{result.row_count}</strong> row{result.row_count === 1 ? '' : 's'}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setShowSql(s => !s)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 border border-[#E8E8E4] text-[11px] font-medium rounded-lg bg-white hover:bg-[#F1EFE8]">
                  <Code size={11} /> {showSql ? 'Hide' : 'Show'} SQL
                </button>
                {result.rows.length > 0 && (
                  <button onClick={downloadCsv}
                    className="inline-flex items-center gap-1 px-2.5 py-1 border border-[#E8E8E4] text-[11px] font-medium rounded-lg bg-white hover:bg-[#F1EFE8]">
                    <Download size={11} /> CSV
                  </button>
                )}
              </div>
            </div>

            {showSql && (
              <pre className="px-4 py-3 bg-[#1A1A2E] text-[#E8E8E4] text-[11px] font-mono overflow-x-auto whitespace-pre-wrap">
                {result.sql}
              </pre>
            )}

            {result.rows.length === 0 ? (
              <div className="px-4 py-8 text-center text-[13px] text-[#1A1A2E]/60">
                No rows matched. Try rephrasing the question.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead className="bg-[#FAFAF8] text-[11px] text-[#1A1A2E] uppercase tracking-wide">
                    <tr>
                      {result.columns.map(c => (
                        <th key={c} className="text-left px-3 py-2 whitespace-nowrap">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F1EFE8]">
                    {result.rows.slice(0, 500).map((row, i) => (
                      <tr key={i} className="hover:bg-[#FAFAF8]">
                        {result.columns.map(c => {
                          const v = row[c]
                          return (
                            <td key={c} className="px-3 py-1.5 align-top whitespace-nowrap">
                              {v == null
                                ? <span className="text-[#1A1A2E]/40">—</span>
                                : typeof v === 'object'
                                  ? <code className="font-mono text-[11px]">{JSON.stringify(v)}</code>
                                  : String(v)}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.rows.length > 500 && (
                  <div className="px-4 py-2 text-[11px] text-[#1A1A2E]/60 bg-[#FAFAF8] border-t border-[#E8E8E4]">
                    Showing first 500 of {result.rows.length} rows. Export CSV for the full set.
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
