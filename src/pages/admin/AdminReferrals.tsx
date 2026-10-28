import { useEffect, useMemo, useState } from 'react'
import { Inbox, Phone, Mail, MapPin, Image as ImageIcon, Megaphone, Check, AlertCircle, X, UserCheck, UserX, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import {
  getReferrals, updateReferral, getRnAvailability, createBroadcast,
  type ReferralIn, type RnAvailability,
} from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import { ZIP_TO_ZONE } from '../../lib/zipData'

function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  try {
    const s = String(d).split('T')[0]
    const [y, m, day] = s.split('-').map(Number)
    return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return d ?? '—' }
}
function fmtTime(iso: string): string {
  const dt = new Date(iso)
  return dt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
function ageFromDob(dob: string | null): string {
  if (!dob) return ''
  try {
    const b = new Date(dob)
    const now = new Date()
    let yrs = now.getFullYear() - b.getFullYear()
    const m = now.getMonth() - b.getMonth()
    if (m < 0 || (m === 0 && now.getDate() < b.getDate())) yrs--
    return yrs >= 2 ? `${yrs}y` : `${Math.max(0, (now.getFullYear() - b.getFullYear()) * 12 + m)}mo`
  } catch { return '' }
}

function extractZip(addr: string | null): string | null {
  if (!addr) return null
  const m = addr.match(/\b(\d{5})\b/)
  return m ? m[1] : null
}

const STATUS_COLORS: Record<string, string> = {
  new:       'bg-[#FEF3C7] text-[#92400E] border-[#FDE68A]',
  contacted: 'bg-[#DBEAFE] text-[#1E40AF] border-[#BFDBFE]',
  scheduled: 'bg-[#D1FAE5] text-[#065F46] border-[#A7F3D0]',
  declined:  'bg-[#FEE2E2] text-[#991B1B] border-[#FECACA]',
  closed:    'bg-[#F3F4F6] text-[#374151] border-[#E5E7EB]',
}

export function AdminReferrals() {
  const { provider } = useAuth()
  const [referrals, setReferrals] = useState<ReferralIn[]>([])
  const [rnAvail, setRnAvail] = useState<RnAvailability | null>(null)
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'open' | 'all'>('open')
  const [broadcasting, setBroadcasting] = useState<string | null>(null)

  const refresh = async () => {
    const [r, a] = await Promise.all([
      getReferrals().catch(() => [] as ReferralIn[]),
      getRnAvailability().catch(() => null),
    ])
    setReferrals(r)
    setRnAvail(a)
    setLoading(false)
  }

  useEffect(() => { refresh() }, [])

  const visible = useMemo(() => {
    if (filter === 'open') return referrals.filter(r => r.status === 'new' || r.status === 'contacted')
    return referrals
  }, [referrals, filter])

  const openCount = referrals.filter(r => r.status === 'new' || r.status === 'contacted').length

  async function setStatus(id: string, status: ReferralIn['status'], note?: string) {
    const next = await updateReferral(id, { status, note })
    setReferrals(prev => prev.map(r => r.id === id ? next : r))
  }

  async function sendIvBroadcast(r: ReferralIn) {
    if (!provider) return
    const ok = window.confirm(`Send an urgent IV RN broadcast for ${r.patient_first_name} ${r.patient_last_name}? Every active RN covering this zone will be alerted.`)
    if (!ok) return
    setBroadcasting(r.id)
    try {
      const zip = extractZip(r.parent_address)
      const zone = zip ? (ZIP_TO_ZONE[zip] ?? null) : null
      await createBroadcast({
        patient_first_name: r.patient_first_name,
        patient_last_name:  r.patient_last_name,
        patient_dob:        r.patient_dob,
        patient_address:    r.parent_address,
        family_phone:       r.parent_phone,
        family_email:       r.parent_email,
        zone,
        state:              'NC',
        visit_type:         'RN in-home IV fluids administration',
        request_type:       'standard',
        complaint:          `IV fluids referral from ${r.referring_uc_name}. ${r.iv_intake?.symptoms ?? ''}`.trim(),
        is_urgent:          true,
        created_by:         provider.id,
        created_by_name:    provider.name ?? 'Admin',
      })
      await updateReferral(r.id, { status: 'contacted', note: 'Sent urgent IV RN broadcast.' })
      await refresh()
      alert('IV RN broadcast sent.')
    } catch (e: any) {
      alert(`Broadcast failed: ${e?.message ?? 'unknown'}`)
    } finally {
      setBroadcasting(null)
    }
  }

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <Inbox size={20} className="text-[#7F77DD]" />
        <h1 className="font-display text-[22px] font-medium text-[#1A1A2E]">Referral inbox</h1>
        {openCount > 0 && (
          <span className="ml-2 bg-[#EF4444] text-white text-[11px] font-semibold px-2 py-0.5 rounded-full">{openCount} open</span>
        )}
      </div>

      <div className="flex items-center gap-1 border-b border-[#E8E8E4] mb-5">
        {(['open', 'all'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-4 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
              filter === f ? 'border-[#7F77DD] text-[#1A1A2E]' : 'border-transparent text-[#1A1A2E]/55 hover:text-[#1A1A2E]'
            }`}
          >{f === 'open' ? `Open (${openCount})` : `All (${referrals.length})`}</button>
        ))}
      </div>

      {loading ? (
        <div className="text-center text-[#1A1A2E]/50 py-12 text-[13px]">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-12 text-center text-[#1A1A2E]/50 text-[13px]">
          No {filter === 'open' ? 'open ' : ''}referrals.
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map(r => {
            const expanded = expandedId === r.id
            return (
              <li key={r.id} className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
                <button
                  onClick={() => setExpandedId(expanded ? null : r.id)}
                  className="w-full px-5 py-4 flex items-start justify-between gap-3 text-left hover:bg-[#FAFAF8] transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-display text-[15px] font-medium text-[#1A1A2E]">
                        {r.patient_first_name} {r.patient_last_name}
                      </span>
                      <span className="text-[12px] text-[#1A1A2E]/60">{ageFromDob(r.patient_dob)}</span>
                      <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${STATUS_COLORS[r.status]}`}>
                        {r.status}
                      </span>
                    </div>
                    <div className="text-[12px] text-[#1A1A2E]/70 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>From <strong>{r.referring_uc_name}</strong> · {r.referring_provider_name}</span>
                      {r.referral_source_kind === 'agency' && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-[#DBEAFE] text-[#1E40AF] border border-[#BFDBFE]">Agency</span>
                      )}
                      <span>· {fmtTime(r.created_at)}</span>
                    </div>
                  </div>
                  {expanded ? <ChevronUp size={16} className="text-[#1A1A2E]/40" /> : <ChevronDown size={16} className="text-[#1A1A2E]/40" />}
                </button>

                {expanded && (
                  <div className="border-t border-[#E8E8E4] bg-[#FAFAF8] p-5 space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="bg-white border border-[#E8E8E4] rounded-lg p-4 space-y-2">
                        <div className="text-[11px] font-semibold text-[#1A1A2E]/60 uppercase tracking-wider">Patient</div>
                        <div className="text-[13px] text-[#1A1A2E]">{r.patient_first_name} {r.patient_last_name}</div>
                        <div className="text-[12px] text-[#1A1A2E]/70">DOB {fmtDate(r.patient_dob)} · {r.patient_gender ?? '—'} · <strong>{r.patient_weight ?? '—'} lbs</strong></div>
                      </div>
                      <div className="bg-white border border-[#E8E8E4] rounded-lg p-4 space-y-1">
                        <div className="text-[11px] font-semibold text-[#1A1A2E]/60 uppercase tracking-wider mb-1">Parent</div>
                        <div className="text-[13px] text-[#1A1A2E]">{r.parent_name}</div>
                        <div className="text-[12px] text-[#1A1A2E]/70 flex items-center gap-1"><Phone size={11} /> <a href={`tel:${r.parent_phone}`} className="text-[#7F77DD] hover:underline">{r.parent_phone}</a></div>
                        <div className="text-[12px] text-[#1A1A2E]/70 flex items-center gap-1"><Mail size={11} /> {r.parent_email}</div>
                        <div className="text-[12px] text-[#1A1A2E]/70 flex items-start gap-1"><MapPin size={11} className="mt-0.5" /> {r.parent_address}</div>
                      </div>
                      <div className="bg-white border border-[#E8E8E4] rounded-lg p-4 space-y-2">
                        <div className="text-[11px] font-semibold text-[#1A1A2E]/60 uppercase tracking-wider">Insurance</div>
                        <div className="text-[13px] text-[#1A1A2E]">{r.insurance_provider || '—'} {r.insurance_member_id ? `· ${r.insurance_member_id}` : ''}</div>
                        {r.subscriber_name && (
                          <div className="text-[12px] text-[#1A1A2E]/70">Subscriber: {r.subscriber_name} {r.subscriber_dob ? `· DOB ${fmtDate(r.subscriber_dob)}` : ''} {r.subscriber_gender ? `· ${r.subscriber_gender}` : ''}</div>
                        )}
                        <div className="flex gap-2 pt-1">
                          {r.insurance_card_front_url && (
                            <a href={r.insurance_card_front_url} target="_blank" rel="noreferrer"><img src={r.insurance_card_front_url} alt="front" className="w-20 h-12 object-cover rounded border border-[#E8E8E4]" /></a>
                          )}
                          {r.insurance_card_back_url && (
                            <a href={r.insurance_card_back_url} target="_blank" rel="noreferrer"><img src={r.insurance_card_back_url} alt="back" className="w-20 h-12 object-cover rounded border border-[#E8E8E4]" /></a>
                          )}
                          {!r.insurance_card_front_url && !r.insurance_card_back_url && (
                            <span className="text-[11px] text-[#1A1A2E]/50 flex items-center gap-1"><ImageIcon size={11} /> No card photos</span>
                          )}
                        </div>
                      </div>
                      <div className="bg-white border border-[#E8E8E4] rounded-lg p-4 space-y-2">
                        <div className="text-[11px] font-semibold text-[#1A1A2E]/60 uppercase tracking-wider">Clinical</div>
                        {r.iv_intake && Object.entries(r.iv_intake).filter(([_, v]) => v).map(([k, v]) => (
                          <div key={k} className="text-[12px] text-[#1A1A2E]/80"><span className="text-[#1A1A2E]/60">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}: </span>{String(v)}</div>
                        ))}
                        {(!r.iv_intake || Object.values(r.iv_intake).every(v => !v)) && (
                          <div className="text-[12px] text-[#1A1A2E]/50 italic">No clinical fields filled in.</div>
                        )}
                      </div>
                    </div>

                    {/* RN availability snapshot */}
                    <div className="bg-white border border-[#E8E8E4] rounded-lg p-4 space-y-3">
                      <div className="text-[11px] font-semibold text-[#1A1A2E]/60 uppercase tracking-wider">RN availability</div>
                      {!rnAvail || rnAvail.rns.length === 0 ? (
                        <div className="text-[12px] text-[#1A1A2E]/50 italic">No active RNs.</div>
                      ) : (
                        <div className="space-y-2">
                          {rnAvail.rns.map(rn => (
                            <div key={rn.id} className="flex items-start gap-2 text-[12px]">
                              <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold flex-shrink-0"
                                style={{ background: rn.avatar_color ?? '#EEE', color: rn.avatar_text_color ?? '#333' }}>
                                {rn.initials ?? rn.name.split(' ').map(s => s[0]).join('').slice(0, 2)}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-[#1A1A2E]">{rn.name}</div>
                                <div className="text-[11px] text-[#1A1A2E]/70">
                                  Today: {rn.today.on ? `${rn.today.start}–${rn.today.end}${rn.today.booked.length ? ` (${rn.today.booked.length} booked)` : ''}` : <span className="text-[#1A1A2E]/50">off</span>}
                                  {' · '}
                                  Tomorrow: {rn.tomorrow.on ? `${rn.tomorrow.start}–${rn.tomorrow.end}${rn.tomorrow.booked.length ? ` (${rn.tomorrow.booked.length} booked)` : ''}` : <span className="text-[#1A1A2E]/50">off</span>}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      <Button variant="teal" size="sm" onClick={() => sendIvBroadcast(r)} loading={broadcasting === r.id} className="w-full">
                        <Megaphone size={14} className="mr-1.5" /> Send urgent IV RN broadcast
                      </Button>
                    </div>

                    {/* Status actions */}
                    <div className="flex flex-wrap gap-2">
                      {r.status === 'new' && (
                        <Button variant="secondary" size="sm" onClick={() => setStatus(r.id, 'contacted', 'Called parent')}>
                          <Check size={13} className="mr-1" /> Mark called
                        </Button>
                      )}
                      {(r.status === 'new' || r.status === 'contacted') && (
                        <>
                          <Button variant="teal" size="sm" onClick={() => setStatus(r.id, 'scheduled', 'Scheduled a visit')}>
                            <UserCheck size={13} className="mr-1" /> Scheduled
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => setStatus(r.id, 'declined', 'Family declined')}>
                            <UserX size={13} className="mr-1" /> Declined
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => setStatus(r.id, 'closed', 'Closed')}>
                            <X size={13} className="mr-1" /> Close
                          </Button>
                        </>
                      )}
                    </div>

                    {/* Activity log */}
                    {r.activity_log && r.activity_log.length > 0 && (
                      <div className="pt-2 border-t border-[#E8E8E4]">
                        <div className="text-[11px] font-semibold text-[#1A1A2E]/60 uppercase tracking-wider mb-2">Activity</div>
                        <ul className="space-y-1">
                          {r.activity_log.slice().reverse().map((e, i) => (
                            <li key={i} className="text-[11px] text-[#1A1A2E]/70 flex items-start gap-2">
                              <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
                              <span>{fmtTime(e.at)} · {e.by}{e.status ? ` → ${e.status}` : ''}{e.note ? ` · ${e.note}` : ''}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
