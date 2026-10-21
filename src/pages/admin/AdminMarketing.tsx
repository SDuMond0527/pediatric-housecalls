import { useEffect, useMemo, useRef, useState } from 'react'
import { Megaphone, Eye, Send, AlertCircle, CheckCircle2, Mail } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import {
  previewMarketingAudience,
  sendMarketingCampaign,
  sendMarketingTest,
  getMarketingCampaigns,
  type MarketingAudience,
  type MarketingCampaign,
  type MarketingFilters,
} from '../../lib/api'

type ActivityWindow = 'any' | 'within' | 'older_than' | 'never'

const inputCls = 'w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:outline-none focus:border-[#7F77DD]'
const labelCls = 'block text-[11px] font-medium text-[#1A1A2E] mb-1.5 uppercase tracking-wider'

function fmtDate(d: string | null): string {
  if (!d) return '—'
  const dt = new Date(d)
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtDateTime(d: string | null): string {
  if (!d) return '—'
  const dt = new Date(d)
  return dt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function AdminMarketing() {
  const [tab, setTab] = useState<'compose' | 'history'>('compose')
  const [campaigns, setCampaigns] = useState<MarketingCampaign[]>([])

  // Compose state
  const [subject, setSubject] = useState('')
  const [html, setHtml] = useState('<p>Hi there,</p>\n<p></p>\n<p>— Pediatric Housecalls</p>')
  const [states, setStates] = useState<Set<'NC' | 'SC' | 'VA'>>(new Set())
  const [ageMin, setAgeMin] = useState('')
  const [ageMax, setAgeMax] = useState('')
  const [activity, setActivity] = useState<ActivityWindow>('any')
  const [activityDays, setActivityDays] = useState('180')

  const [audience, setAudience] = useState<MarketingAudience | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendingTest, setSendingTest] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const previewRef = useRef<HTMLIFrameElement>(null)

  const filters: MarketingFilters = useMemo(() => ({
    states: states.size > 0 ? Array.from(states) : undefined,
    age_min: ageMin ? parseInt(ageMin, 10) : null,
    age_max: ageMax ? parseInt(ageMax, 10) : null,
    last_visit_within_days:   activity === 'within'     ? parseInt(activityDays, 10) : null,
    last_visit_older_than_days: activity === 'older_than' ? parseInt(activityDays, 10) : null,
    never_visited: activity === 'never',
  }), [states, ageMin, ageMax, activity, activityDays])

  useEffect(() => {
    getMarketingCampaigns().then(setCampaigns).catch(() => {})
  }, [])

  // Any filter change invalidates the preview — forces the biller to
  // re-run audience preview before sending.
  useEffect(() => { setAudience(null) }, [filters])

  // Live HTML preview via iframe srcdoc.
  useEffect(() => {
    if (!previewRef.current) return
    previewRef.current.srcdoc = `<style>body{font-family:-apple-system,Segoe UI,sans-serif;color:#1A1A2E;padding:12px;margin:0;}</style>${html}`
  }, [html])

  const toggleState = (s: 'NC' | 'SC' | 'VA') => {
    setStates(prev => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s); else next.add(s)
      return next
    })
  }

  async function handlePreview() {
    setPreviewing(true)
    setResult(null)
    try {
      const a = await previewMarketingAudience(filters)
      setAudience(a)
    } catch (e: any) {
      setResult({ ok: false, msg: e?.message ?? 'Preview failed' })
    } finally {
      setPreviewing(false)
    }
  }

  async function handleSendTest() {
    if (!subject.trim()) { setResult({ ok: false, msg: 'Subject is empty' }); return }
    if (!html.trim())    { setResult({ ok: false, msg: 'Body is empty' }); return }
    setSendingTest(true)
    setResult(null)
    try {
      const r = await sendMarketingTest({ subject, html })
      setResult({ ok: true, msg: r.skipped ? `Test skipped — Resend not configured. (Would have gone to ${r.to}.)` : `Test sent to ${r.to}. Check your inbox.` })
    } catch (e: any) {
      setResult({ ok: false, msg: e?.message ?? 'Test send failed' })
    } finally {
      setSendingTest(false)
    }
  }

  async function handleSend() {
    if (!audience) return
    if (!subject.trim()) { setResult({ ok: false, msg: 'Subject is empty' }); return }
    if (!html.trim())    { setResult({ ok: false, msg: 'Body is empty' }); return }
    const ok = window.confirm(
      `Send "${subject}" to ${audience.count} famil${audience.count === 1 ? 'y' : 'ies'}?\n\n` +
      `This cannot be undone. Each recipient will see your subject, body, and an unsubscribe link.`
    )
    if (!ok) return
    setSending(true)
    setResult(null)
    try {
      const r = await sendMarketingCampaign({
        subject, html, filters, expected_count: audience.count,
      })
      setResult({ ok: true, msg: `Sent to ${r.sent} famil${r.sent === 1 ? 'y' : 'ies'}${r.failed ? ` (${r.failed} failed)` : ''}.` })
      setAudience(null)
      getMarketingCampaigns().then(setCampaigns).catch(() => {})
    } catch (e: any) {
      setResult({ ok: false, msg: e?.message ?? 'Send failed' })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <Megaphone size={20} className="text-[#7F77DD]" />
        <h1 className="font-display text-[22px] font-medium text-[#1A1A2E]">Marketing</h1>
      </div>

      <div className="flex items-center gap-1 border-b border-[#E8E8E4] mb-6">
        <button
          onClick={() => setTab('compose')}
          className={`px-4 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
            tab === 'compose' ? 'border-[#7F77DD] text-[#1A1A2E]' : 'border-transparent text-[#1A1A2E]/55 hover:text-[#1A1A2E]'
          }`}
        >Compose</button>
        <button
          onClick={() => setTab('history')}
          className={`px-4 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
            tab === 'history' ? 'border-[#7F77DD] text-[#1A1A2E]' : 'border-transparent text-[#1A1A2E]/55 hover:text-[#1A1A2E]'
          }`}
        >History ({campaigns.length})</button>
      </div>

      {tab === 'compose' && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
          <div className="space-y-4">
            <div>
              <label className={labelCls}>Subject</label>
              <input value={subject} onChange={e => setSubject(e.target.value)} className={inputCls} placeholder="e.g. Flu season is here — book your sick visits in-home" />
            </div>

            <div>
              <label className={labelCls}>Body (HTML)</label>
              <textarea
                value={html}
                onChange={e => setHtml(e.target.value)}
                className={`${inputCls} font-mono text-[12px]`}
                rows={14}
                placeholder="<p>Hi there,</p>..."
              />
              <p className="text-[11px] text-[#1A1A2E]/50 mt-1.5">
                Plain HTML. A branded wrapper + unsubscribe link are added automatically.
              </p>
            </div>

            <div>
              <label className={labelCls}>Preview</label>
              <iframe
                ref={previewRef}
                title="Email preview"
                className="w-full h-64 bg-white border border-[#E8E8E4] rounded-lg"
              />
            </div>
          </div>

          <div className="space-y-4">
            <div className="bg-white border border-[#E8E8E4] rounded-xl p-4 space-y-4">
              <div className="text-[13px] font-semibold text-[#1A1A2E]">Audience filters</div>

              <div>
                <label className={labelCls}>State</label>
                <div className="flex gap-2">
                  {(['NC', 'SC', 'VA'] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => toggleState(s)}
                      className={`px-3 py-1.5 text-[12px] font-medium rounded-lg border transition-colors ${
                        states.has(s)
                          ? 'bg-[#7F77DD] border-[#7F77DD] text-white'
                          : 'bg-white border-[#E8E8E4] text-[#1A1A2E] hover:border-[#7F77DD]'
                      }`}
                    >{s}</button>
                  ))}
                </div>
                {states.size === 0 && (
                  <p className="text-[11px] text-[#1A1A2E]/50 mt-1">No filter → all states.</p>
                )}
              </div>

              <div>
                <label className={labelCls}>Child age (years)</label>
                <div className="flex items-center gap-2">
                  <input value={ageMin} onChange={e => setAgeMin(e.target.value.replace(/\D/g, ''))} placeholder="Min" className={`${inputCls} w-20`} />
                  <span className="text-[12px] text-[#1A1A2E]/50">to</span>
                  <input value={ageMax} onChange={e => setAgeMax(e.target.value.replace(/\D/g, ''))} placeholder="Max" className={`${inputCls} w-20`} />
                </div>
                <p className="text-[11px] text-[#1A1A2E]/50 mt-1">
                  Family qualifies if youngest ≥ min AND oldest ≤ max.
                </p>
              </div>

              <div>
                <label className={labelCls}>Last visit</label>
                <select value={activity} onChange={e => setActivity(e.target.value as ActivityWindow)} className={inputCls}>
                  <option value="any">Any</option>
                  <option value="within">Within N days</option>
                  <option value="older_than">Older than N days (dormant)</option>
                  <option value="never">Never visited</option>
                </select>
                {(activity === 'within' || activity === 'older_than') && (
                  <input
                    value={activityDays}
                    onChange={e => setActivityDays(e.target.value.replace(/\D/g, ''))}
                    placeholder="Days"
                    className={`${inputCls} mt-2`}
                  />
                )}
              </div>

              <Button variant="secondary" size="sm" onClick={handlePreview} loading={previewing} className="w-full">
                <Eye size={14} className="mr-1" /> Preview recipients
              </Button>
            </div>

            <div className="bg-white border border-[#E8E8E4] rounded-xl p-4 space-y-2">
              <div className="text-[13px] font-semibold text-[#1A1A2E]">Test it on yourself first</div>
              <p className="text-[11px] text-[#1A1A2E]/60">
                Sends only to your admin email with a <strong>[TEST]</strong> subject prefix and a yellow banner. Audience filters are ignored.
              </p>
              <Button variant="secondary" size="sm" onClick={handleSendTest} loading={sendingTest} className="w-full">
                <Mail size={14} className="mr-1" /> Send test to me
              </Button>
            </div>

            {audience && (
              <div className="bg-white border border-[#E8E8E4] rounded-xl p-4 space-y-3">
                <div className="text-[13px] font-semibold text-[#1A1A2E]">
                  {audience.count} famil{audience.count === 1 ? 'y' : 'ies'} match
                </div>
                {audience.sample.length > 0 && (
                  <div className="space-y-1">
                    {audience.sample.map((r, i) => (
                      <div key={i} className="text-[12px] text-[#1A1A2E]/80 truncate">
                        {r.display_name || r.email} · {r.state ?? '—'} · last {fmtDate(r.last_visit)}
                      </div>
                    ))}
                    {audience.count > audience.sample.length && (
                      <div className="text-[11px] text-[#1A1A2E]/50 italic">+ {audience.count - audience.sample.length} more</div>
                    )}
                  </div>
                )}
                <Button variant="teal" size="sm" onClick={handleSend} loading={sending} className="w-full" disabled={audience.count === 0}>
                  <Send size={14} className="mr-1" /> Send to {audience.count}
                </Button>
              </div>
            )}

            {result && (
              <div className={`rounded-xl p-3 flex items-start gap-2 text-[12px] ${
                result.ok ? 'bg-[#F0FDF4] border border-[#1D9E75]/30 text-[#1A7D5A]'
                          : 'bg-[#FEF2F2] border border-[#EF4444]/30 text-[#B91C1C]'
              }`}>
                {result.ok ? <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" /> : <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />}
                <div>{result.msg}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
          {campaigns.length === 0 ? (
            <div className="p-12 text-center text-[#1A1A2E]/50 text-[13px]">No campaigns sent yet.</div>
          ) : (
            <table className="w-full text-[13px]">
              <thead className="bg-[#FAFAF8] text-[11px] uppercase tracking-wider text-[#1A1A2E]/60">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Subject</th>
                  <th className="text-left px-4 py-2 font-medium">Sent by</th>
                  <th className="text-right px-4 py-2 font-medium">Audience</th>
                  <th className="text-right px-4 py-2 font-medium">Sent</th>
                  <th className="text-right px-4 py-2 font-medium">Failed</th>
                  <th className="text-left px-4 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map(c => (
                  <tr key={c.id} className="border-t border-[#E8E8E4]">
                    <td className="px-4 py-2 text-[#1A1A2E] truncate max-w-[280px]">{c.subject}</td>
                    <td className="px-4 py-2 text-[#1A1A2E]/70">{c.sent_by_name}</td>
                    <td className="px-4 py-2 text-right text-[#1A1A2E]/70">{c.audience_count}</td>
                    <td className="px-4 py-2 text-right text-[#1A1A2E]">{c.sent_count}</td>
                    <td className="px-4 py-2 text-right text-[#EF4444]">{c.failed_count || ''}</td>
                    <td className="px-4 py-2 text-[#1A1A2E]/70">{fmtDateTime(c.completed_at ?? c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
