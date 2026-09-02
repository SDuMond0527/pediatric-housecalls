import { useEffect, useState } from 'react'
import { Shield } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { familyGetEncounterNotes } from '../../lib/api'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'

interface VaccineEntry {
  vaccine_name: string
  manufacturer?: string
  lot_number?: string
  expiration_date?: string
  dose?: string
  route?: string
  site?: string
  administered_by?: string
}

interface VaccineNote {
  id: string
  child_id: string
  child_name: string
  note_type: string | null
  scheduled_date: string | null
  provider_name: string | null
  vaccine_administrations?: VaccineEntry[]
}

export function FamilyVaccines() {
  const { children } = useFamilyAuth()
  const [notes, setNotes] = useState<VaccineNote[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    familyGetEncounterNotes()
      .then((data: any[]) => {
        const vaccineNotes = (data ?? []).filter(
          (n: any) => n.note_type === 'In-home vaccine administration' && n.vaccine_administrations?.length
        )
        setNotes(vaccineNotes)
      })
      .catch(() => setNotes([]))
      .finally(() => setLoading(false))
  }, [])

  const multiChild = (children?.length ?? 0) > 1

  // Group by child
  const byChild: Record<string, VaccineNote[]> = {}
  notes.forEach(n => {
    if (!byChild[n.child_id]) byChild[n.child_id] = []
    byChild[n.child_id].push(n)
  })

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-display text-[22px] font-semibold text-[#1A1A2E]">Vaccine history</h1>
        <p className="text-[13px] text-[#999] mt-1">Vaccines administered by our practice</p>
      </div>

      {loading && (
        <div className="text-center py-16 text-[#999] text-[14px]">Loading vaccine records…</div>
      )}

      {!loading && notes.length === 0 && (
        <div className="text-center py-16">
          <Shield size={32} className="text-[#E8E8E4] mx-auto mb-3" />
          <div className="text-[14px] text-[#999]">No vaccine records on file.</div>
          <div className="text-[13px] text-[#bbb] mt-1">Vaccines will appear here after they are administered and the note is signed.</div>
        </div>
      )}

      {!loading && notes.length > 0 && (
        <div className="space-y-8">
          {Object.entries(byChild).map(([childId, childNotes]) => (
            <div key={childId}>
              {multiChild && (
                <div className="text-[13px] font-semibold text-[#7F77DD] mb-3">
                  {childNotes[0].child_name}
                </div>
              )}
              <div className="space-y-4">
                {childNotes.map(note => (
                  <div key={note.id}>
                    <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider mb-2">
                      {note.scheduled_date ? format(parseISO(note.scheduled_date), 'MMMM d, yyyy') : 'Date unknown'}
                      {note.provider_name && (
                        <span className="ml-2 font-normal normal-case">· {note.provider_name}</span>
                      )}
                    </div>
                    <div className="border border-[#E8E8E4] rounded-xl overflow-hidden bg-white shadow-sm">
                      <div className="overflow-x-auto">
                        <table className="w-full text-[13px] min-w-[480px]">
                          <thead>
                            <tr className="border-b border-[#E8E8E4] bg-[#FAFAF8]">
                              <th className="text-left px-4 py-2.5 text-[11px] text-[#999] font-medium">Vaccine</th>
                              <th className="text-left px-4 py-2.5 text-[11px] text-[#999] font-medium">Lot #</th>
                              <th className="text-left px-4 py-2.5 text-[11px] text-[#999] font-medium">Dose</th>
                              <th className="text-left px-4 py-2.5 text-[11px] text-[#999] font-medium">Route / Site</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(note.vaccine_administrations ?? []).map((v, i) => (
                              <tr key={i} className={i > 0 ? 'border-t border-[#F0F0EC]' : ''}>
                                <td className="px-4 py-3 font-medium text-[#1A1A2E]">
                                  {v.vaccine_name}
                                  {v.manufacturer && (
                                    <div className="text-[11px] text-[#999] font-normal">{v.manufacturer}</div>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-[#555]">{v.lot_number || '—'}</td>
                                <td className="px-4 py-3 text-[#555]">{v.dose || '—'}</td>
                                <td className="px-4 py-3 text-[#555]">
                                  {[v.route, v.site].filter(Boolean).join(' · ') || '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
