import { useEffect, useState } from 'react'
import { X, UserPlus, Loader2, CheckCircle2, AlertCircle, Copy, Check } from 'lucide-react'
import { inviteProvider, getProviders, getPracticeZones } from '../lib/api'

// Super-admin modal for inviting a new provider to the practice.
// Collects email, name, role, (if NP) supervising MD, zones, and visit
// types. Posts to /api/admin/invite-provider which creates a Cognito
// account + sends a Resend email with the onboarding URL.
//
// Sara 2026-11-19.

const ROLES: Array<{ value: string; label: string }> = [
  { value: 'MD',  label: 'MD — Physician' },
  { value: 'NP',  label: 'NP — Nurse Practitioner' },
  { value: 'PNP', label: 'PNP — Pediatric Nurse Practitioner' },
  { value: 'PA',  label: 'PA — Physician Assistant' },
  { value: 'RN',  label: 'RN — Registered Nurse' },
  { value: 'CMA', label: 'CMA — Certified Medical Assistant' },
  { value: 'MA',  label: 'MA — Medical Assistant' },
]

const REQUIRES_SUPERVISOR = new Set(['NP', 'PNP', 'PA'])

type Props = {
  open: boolean
  onClose: () => void
  onSuccess?: () => void
}

export function InviteProviderModal({ open, onClose, onSuccess }: Props) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<string>('MD')
  const [supervisorId, setSupervisorId] = useState<string>('')
  const [zones, setZones] = useState<string[]>([])
  const [welcomeNote, setWelcomeNote] = useState('')
  const [availableMds, setAvailableMds] = useState<Array<{ id: string; name: string }>>([])
  const [availableZones, setAvailableZones] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<null | { onboarding_url: string; email_sent: boolean; email_error: string | null }>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) return
    // Reset form every time the modal opens so stale state doesn't leak.
    setFirstName(''); setLastName(''); setEmail(''); setRole('MD')
    setSupervisorId(''); setZones([]); setWelcomeNote('')
    setError(null); setSuccess(null); setCopied(false)
    Promise.all([
      getProviders().then(ps => setAvailableMds(ps.filter((p: any) => p.role === 'MD').map((p: any) => ({ id: p.id, name: p.name })))).catch(() => {}),
      getPracticeZones().then(zs => setAvailableZones(zs.map((z: any) => z.name ?? z))).catch(() => {}),
    ])
  }, [open])

  const requiresSupervisor = REQUIRES_SUPERVISOR.has(role)

  async function submit() {
    setError(null)
    if (!firstName.trim() || !lastName.trim()) { setError('First and last name required'); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Valid email required'); return }
    if (requiresSupervisor && !supervisorId) { setError(`${role} requires a supervising MD`); return }
    setSubmitting(true)
    try {
      const res = await inviteProvider({
        email: email.trim().toLowerCase(),
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        role: role as any,
        supervising_md_id: supervisorId || null,
        zones,
        welcome_note: welcomeNote.trim() || null,
      })
      setSuccess({
        onboarding_url: res.onboarding_url,
        email_sent: res.email_sent,
        email_error: res.email_error,
      })
      onSuccess?.()
    } catch (e: any) {
      setError(e?.message ?? 'Invite failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#E8E8E4]">
          <div className="flex items-center gap-2">
            <UserPlus size={18} className="text-[#7F77DD]" />
            <h2 className="font-display text-[16px] font-medium text-[#1A1A2E]">Invite provider</h2>
          </div>
          <button onClick={onClose} className="text-[#555] hover:text-[#1A1A2E]"><X size={18} /></button>
        </div>

        {success ? (
          <div className="px-5 py-5 space-y-3">
            <div className="flex items-start gap-2">
              <CheckCircle2 size={16} className="text-[#1D9E75] mt-0.5" />
              <div className="flex-1">
                <div className="text-[14px] font-medium text-[#1A1A2E]">Invite created.</div>
                <div className="text-[12px] text-[#555] mt-0.5">
                  {success.email_sent
                    ? 'The invite email was sent to the new provider.'
                    : `The invite was saved but the email failed to send: ${success.email_error ?? 'unknown error'}. You can copy the onboarding URL below.`}
                </div>
              </div>
            </div>
            <div className="bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-3">
              <div className="text-[10px] font-semibold text-[#555] uppercase tracking-wider mb-1">Onboarding URL (expires in 7 days)</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-[11px] font-mono bg-white border border-[#E8E8E4] rounded px-2 py-1.5 truncate">{success.onboarding_url}</code>
                <button
                  onClick={() => { navigator.clipboard.writeText(success.onboarding_url); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                  className="inline-flex items-center gap-1 text-[12px] text-[#7F77DD] border border-[#7F77DD] rounded px-2 py-1 hover:bg-[#EEEDFE]">
                  {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={onClose} className="px-4 py-2 text-[13px] text-[#555] border border-[#E8E8E4] rounded-lg hover:bg-[#F1EFE8]">Close</button>
            </div>
          </div>
        ) : (
          <div className="px-5 py-5 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider block mb-1">First name</label>
                <input value={firstName} onChange={e => setFirstName(e.target.value)} className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" />
              </div>
              <div>
                <label className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider block mb-1">Last name</label>
                <input value={lastName} onChange={e => setLastName(e.target.value)} className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" />
              </div>
            </div>
            <div>
              <label className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider block mb-1">Work email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider block mb-1">Role</label>
              <select value={role} onChange={e => setRole(e.target.value)} className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]">
                {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            {requiresSupervisor && (
              <div>
                <label className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider block mb-1">
                  Supervising MD <span className="text-[#991B1B]">*</span>
                </label>
                <select value={supervisorId} onChange={e => setSupervisorId(e.target.value)} className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]">
                  <option value="">Select supervising MD…</option>
                  {availableMds.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <div className="text-[11px] text-[#555] mt-1">Required for co-sign routing when this provider signs encounter notes.</div>
              </div>
            )}
            {availableZones.length > 0 && (
              <div>
                <label className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider block mb-1">Zones they'll cover</label>
                <div className="flex flex-wrap gap-1.5">
                  {availableZones.map(z => (
                    <button
                      key={z}
                      type="button"
                      onClick={() => setZones(prev => prev.includes(z) ? prev.filter(x => x !== z) : [...prev, z])}
                      className={`text-[11px] px-2.5 py-1 rounded-full border ${zones.includes(z) ? 'bg-[#EEEDFE] border-[#7F77DD] text-[#3C3489]' : 'bg-white border-[#E8E8E4] text-[#555]'}`}>
                      {z}
                    </button>
                  ))}
                </div>
                <div className="text-[11px] text-[#555] mt-1">Optional. The new provider will confirm during setup.</div>
              </div>
            )}
            <div>
              <label className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider block mb-1">Welcome note (optional)</label>
              <textarea
                value={welcomeNote}
                onChange={e => setWelcomeNote(e.target.value)}
                rows={2}
                placeholder="A short personal message that shows at the top of the invite email."
                className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD] resize-y" />
            </div>

            {error && (
              <div className="flex items-start gap-2 text-[12px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">
                <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> <span>{error}</span>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="px-4 py-2 text-[13px] text-[#555] border border-[#E8E8E4] rounded-lg hover:bg-[#F1EFE8]">Cancel</button>
              <button
                onClick={submit}
                disabled={submitting}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium text-white bg-[#7F77DD] rounded-lg hover:bg-[#6B64C8] disabled:opacity-50">
                {submitting && <Loader2 size={13} className="animate-spin" />} Send invite
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
