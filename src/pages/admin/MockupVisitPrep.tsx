import { useState } from 'react'
import { MapPin, AlertTriangle, FileText, Phone, Mail, Pill, Heart, ExternalLink, X, Clock, Stethoscope, Shield } from 'lucide-react'

/**
 * Static mockup — not wired to real data. Lets Sara react to the layout
 * before I invest in the integration. Delete after design is finalized.
 */

const mock = {
  patient_initials: 'E.W.',
  patient_name_full: 'Everett Wells',
  age: '18 y',
  visit_type: 'In-home sick visit',
  scheduled_time: '10:30 AM',
  scheduled_date: 'Wednesday, Nov 5',
  address: '122 Pine Grove Dr, Charlotte, NC 28210',

  last_visit: {
    date: 'Aug 31, 2026',
    visit_type: 'Well child visit',
    provider: 'Megan Heilemann, PNP',
    cc: 'Routine physical, no acute concerns',
    assessment: 'Healthy, continue current meds. Follow up in 6 months or prn.',
  },

  chronic_problems: ['Asthma, mild intermittent', 'Seasonal allergic rhinitis'],

  allergies: ['Amoxicillin — hives'],

  booking_complaint: 'Fever x 2 days, sore throat, decreased appetite. Mom reports he hasn\'t eaten since yesterday.',

  chart_gaps: [
    { label: 'Insurance card photo (back)', severity: 'warning', note: 'Front uploaded, back is missing' },
    { label: 'Chief complaint fields incomplete', severity: 'info', note: 'Allergies & current meds last reviewed 11 months ago' },
  ],

  upcoming_orders: [
    { kind: 'Lab', test: 'Strep culture', ordered: 'Oct 28', status: 'Pending result' },
  ],

  parent_contact: { phone: '+1 (425) 330-8041', email: 'chrissyleawells@gmail.com' },
}

export function MockupVisitPrep() {
  const [open, setOpen] = useState(true)

  const addressMaps = `https://maps.apple.com/?q=${encodeURIComponent(mock.address)}`

  return (
    <div className="min-h-screen bg-[#1A1A2E]/40 relative">
      {/* Dim "Today's schedule" background to simulate context */}
      <div className="opacity-30 pointer-events-none p-6">
        <div className="max-w-2xl mx-auto space-y-3">
          <div className="font-display text-[22px] font-medium text-[#1A1A2E]">Today — Wednesday, Nov 5</div>
          {[1,2,3].map(i => (
            <div key={i} className="bg-white border border-[#E8E8E4] rounded-xl p-4 h-24" />
          ))}
        </div>
      </div>

      {!open && (
        <div className="fixed inset-0 flex items-center justify-center">
          <button onClick={() => setOpen(true)} className="px-4 py-2 bg-[#7F77DD] text-white text-[13px] font-medium rounded-lg">
            Reopen mockup
          </button>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 bg-black/40 flex items-start sm:items-center justify-center p-3 overflow-y-auto">
          <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl my-4 relative">
            {/* Close */}
            <button onClick={() => setOpen(false)} className="absolute top-3 right-3 p-1.5 rounded-full hover:bg-[#F1EFE8] text-[#1A1A2E]/60 z-10">
              <X size={16} />
            </button>

            {/* Header */}
            <div className="p-5 pb-4 border-b border-[#E8E8E4]">
              <div className="flex items-center gap-3 mb-1">
                <div className="w-11 h-11 rounded-full bg-[#EEEDFE] flex items-center justify-center text-[#3C3489] font-semibold text-[14px] flex-shrink-0">
                  {mock.patient_initials}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-display text-[16px] font-semibold text-[#1A1A2E]">{mock.patient_name_full}</div>
                  <div className="text-[12px] text-[#1A1A2E]/70">{mock.age} · {mock.visit_type}</div>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[12px] text-[#1A1A2E]/80 mt-2">
                <Clock size={12} /> {mock.scheduled_date} · {mock.scheduled_time}
              </div>
            </div>

            {/* Allergies — RED, top for safety */}
            <div className="px-5 py-3 border-b border-[#E8E8E4] bg-[#FEF2F2]">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-[#991B1B] uppercase tracking-wider mb-1">
                <AlertTriangle size={11} /> Allergies
              </div>
              {mock.allergies.length === 0 ? (
                <div className="text-[13px] text-[#1A1A2E]">No known drug allergies.</div>
              ) : (
                <ul className="text-[13px] text-[#1A1A2E] space-y-0.5">
                  {mock.allergies.map(a => <li key={a}>• {a}</li>)}
                </ul>
              )}
            </div>

            {/* Address */}
            <div className="px-5 py-3 border-b border-[#E8E8E4]">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-[#1A1A2E]/60 uppercase tracking-wider mb-1">
                <MapPin size={11} /> Address
              </div>
              <a href={addressMaps} className="text-[13px] text-[#7F77DD] font-medium flex items-center gap-1 hover:underline">
                {mock.address} <ExternalLink size={11} />
              </a>
            </div>

            {/* Why they booked */}
            <div className="px-5 py-3 border-b border-[#E8E8E4]">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-[#1A1A2E]/60 uppercase tracking-wider mb-1">
                <Stethoscope size={11} /> Why they booked
              </div>
              <div className="text-[13px] text-[#1A1A2E] italic">"{mock.booking_complaint}"</div>
            </div>

            {/* Chronic problems */}
            <div className="px-5 py-3 border-b border-[#E8E8E4]">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-[#1A1A2E]/60 uppercase tracking-wider mb-1">
                <Heart size={11} /> Chronic problems
              </div>
              {mock.chronic_problems.length === 0 ? (
                <div className="text-[13px] text-[#1A1A2E]/60 italic">None on file.</div>
              ) : (
                <ul className="text-[13px] text-[#1A1A2E] space-y-0.5">
                  {mock.chronic_problems.map(p => <li key={p}>• {p}</li>)}
                </ul>
              )}
            </div>

            {/* Last visit */}
            <div className="px-5 py-3 border-b border-[#E8E8E4]">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-[#1A1A2E]/60 uppercase tracking-wider mb-1">
                <FileText size={11} /> Last visit
              </div>
              <div className="text-[13px] text-[#1A1A2E] font-medium">{mock.last_visit.date} · {mock.last_visit.visit_type}</div>
              <div className="text-[12px] text-[#1A1A2E]/70 mb-1">{mock.last_visit.provider}</div>
              <div className="text-[12px] text-[#1A1A2E]/80"><span className="font-medium">CC:</span> {mock.last_visit.cc}</div>
              <div className="text-[12px] text-[#1A1A2E]/80 mt-0.5"><span className="font-medium">A/P:</span> {mock.last_visit.assessment}</div>
            </div>

            {/* Chart gaps — yellow */}
            {mock.chart_gaps.length > 0 && (
              <div className="px-5 py-3 border-b border-[#E8E8E4] bg-[#FEF3C7]">
                <div className="flex items-center gap-2 text-[11px] font-semibold text-[#92400E] uppercase tracking-wider mb-1">
                  <AlertTriangle size={11} /> Chart gaps
                </div>
                <ul className="space-y-2">
                  {mock.chart_gaps.map(g => (
                    <li key={g.label} className="text-[12px] text-[#1A1A2E] flex items-start justify-between gap-2">
                      <div>
                        <div className="font-medium">{g.label}</div>
                        <div className="text-[11px] text-[#1A1A2E]/70">{g.note}</div>
                      </div>
                      <button className="text-[11px] text-[#92400E] font-semibold whitespace-nowrap hover:underline">Ask parent</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Upcoming orders */}
            {mock.upcoming_orders.length > 0 && (
              <div className="px-5 py-3 border-b border-[#E8E8E4]">
                <div className="flex items-center gap-2 text-[11px] font-semibold text-[#1A1A2E]/60 uppercase tracking-wider mb-1">
                  <Pill size={11} /> Pending labs / orders
                </div>
                <ul className="text-[12px] text-[#1A1A2E] space-y-0.5">
                  {mock.upcoming_orders.map((o, i) => (
                    <li key={i}>• {o.kind}: {o.test} ({o.ordered}) — <span className="text-[#1A1A2E]/60">{o.status}</span></li>
                  ))}
                </ul>
              </div>
            )}

            {/* Parent contact */}
            <div className="px-5 py-3 border-b border-[#E8E8E4]">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-[#1A1A2E]/60 uppercase tracking-wider mb-1">
                <Shield size={11} /> Parent contact
              </div>
              <div className="text-[12px] text-[#1A1A2E] space-y-0.5">
                <div className="flex items-center gap-2"><Phone size={11} /> <a href={`tel:${mock.parent_contact.phone}`} className="text-[#7F77DD]">{mock.parent_contact.phone}</a></div>
                <div className="flex items-center gap-2"><Mail size={11} /> {mock.parent_contact.email}</div>
              </div>
            </div>

            {/* Actions */}
            <div className="p-4 flex gap-2">
              <button className="flex-1 py-2.5 bg-[#7F77DD] text-white text-[13px] font-semibold rounded-lg hover:bg-[#6B61C7]">
                Open full chart
              </button>
              <button onClick={() => setOpen(false)} className="flex-1 py-2.5 border border-[#E8E8E4] text-[#1A1A2E] text-[13px] font-semibold rounded-lg hover:bg-[#F1EFE8]">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
