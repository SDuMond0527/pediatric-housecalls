import { Trash2, CheckCircle2 } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { InsuranceEditor, type InsuranceValue } from './InsuranceEditor'
import { PharmacyAutocomplete } from './PharmacyAutocomplete'

// Shared per-child intake form used at family signup (FamilySetup) and
// when adding a sibling from FamilyProfile. Same shape everywhere so we
// never create a skeleton chart. See memory:
// feedback_all_patient_info_required_and_displayed.md,
// project_signup_intake_gate.md.

const VAX_OPTIONS = [
  { value: 'fully_vaccinated', label: 'Fully vaccinated on schedule' },
  { value: 'delayed',          label: 'Delayed / alternative schedule' },
  { value: 'unvaccinated',     label: 'Not vaccinated' },
]

export type ChildEntry = {
  first_name: string
  last_name: string
  date_of_birth: string
  gender: string
  allergies: string
  current_medications: string
  medical_history: string
  preferred_pharmacy: string
  /** Concrete DoseSpot pharmacy_id from the intake-time autocomplete —
   *  when present, the DoseSpot SSO endpoint uses it directly and skips
   *  fuzzy-matching. Optional so legacy free-text entries still work. */
  dosespot_pharmacy_id: number | null
  pcp: string
  vaccination_status: string
  self_pay: boolean
  insurance_provider: string
  insurance_member_id: string
  insurance_group_number: string
  insurance_dependent_code: string
  insurance_subscriber_name: string
  insurance_subscriber_dob: string
  insurance_subscriber_gender: string
  insurance_subscriber_relationship: string
  insurance_card_front_url: string
  insurance_card_back_url: string
  match: { id: string; first_name: string; last_name: string; date_of_birth: string; parent_phone: string | null; parent_email: string | null; parent_address: string | null } | null
  matchDismissed: boolean
  matchConfirmed: boolean
}

export function emptyChild(): ChildEntry {
  return {
    first_name: '', last_name: '', date_of_birth: '',
    gender: '', allergies: '', current_medications: '', medical_history: '',
    preferred_pharmacy: '', dosespot_pharmacy_id: null, pcp: '', vaccination_status: '',
    self_pay: false,
    insurance_provider: '', insurance_member_id: '', insurance_group_number: '', insurance_dependent_code: '',
    insurance_subscriber_name: '', insurance_subscriber_dob: '',
    insurance_subscriber_gender: '', insurance_subscriber_relationship: 'child',
    insurance_card_front_url: '', insurance_card_back_url: '',
    match: null, matchDismissed: false, matchConfirmed: false,
  }
}

/**
 * Build an empty ChildEntry that pre-fills the FAMILY-WIDE fields
 * (pharmacy, PCP, insurance, subscriber, cards, last name) from a
 * sibling — so a parent adding a second, third, fourth kid doesn't
 * have to retype the same pharmacy / PCP / insurance info they've
 * already given us. Child-specific fields (first name, DOB, gender,
 * allergies, meds, history, vaccination status) stay blank because
 * they never inherit.
 *
 * Pass ANY existing sibling record (children[0] is fine — every
 * sibling shares the same family plan / pharmacy / PCP by design).
 * If no sibling exists, use emptyChild() instead.
 */
export function emptyChildInheritingFrom(sibling: any): ChildEntry {
  const s = sibling ?? {}
  const isSelfPay = String(s.insurance_provider ?? '').toLowerCase() === 'self-pay'
  const subDob = s.insurance_subscriber_dob ? String(s.insurance_subscriber_dob).split('T')[0] : ''
  return {
    first_name:  '',
    last_name:   String(s.last_name ?? ''),
    date_of_birth: '',
    gender:      '',
    allergies:   '',
    current_medications: '',
    medical_history:     '',
    preferred_pharmacy:  String(s.preferred_pharmacy ?? ''),
    dosespot_pharmacy_id: (s.dosespot_pharmacy_id as number | null | undefined) ?? null,
    pcp:                 String(s.pcp ?? ''),
    vaccination_status:  '',
    self_pay:            isSelfPay,
    insurance_provider:      isSelfPay ? '' : String(s.insurance_provider      ?? ''),
    insurance_member_id:     isSelfPay ? '' : String(s.insurance_member_id     ?? ''),
    insurance_group_number:  isSelfPay ? '' : String(s.insurance_group_number  ?? ''),
    insurance_dependent_code:'',  // dep code is child-specific for BCBS NC — never inherit
    insurance_subscriber_name:     isSelfPay ? '' : String(s.insurance_subscriber_name     ?? ''),
    insurance_subscriber_dob:      isSelfPay ? '' : subDob,
    insurance_subscriber_gender:   isSelfPay ? '' : String(s.insurance_subscriber_gender   ?? ''),
    insurance_subscriber_relationship: isSelfPay ? 'child' : String(s.insurance_subscriber_relationship ?? 'child'),
    insurance_card_front_url:      isSelfPay ? '' : String(s.insurance_card_front_url ?? ''),
    insurance_card_back_url:       isSelfPay ? '' : String(s.insurance_card_back_url  ?? ''),
    match: null, matchDismissed: false, matchConfirmed: false,
  }
}

/** Return the label of the first missing required field, or null if complete. */
export function childIsComplete(c: ChildEntry): string | null {
  if (!c.first_name.trim()) return 'First name'
  if (!c.last_name.trim()) return 'Last name'
  if (!c.date_of_birth) return 'Date of birth'
  if (!c.gender) return 'Sex'
  if (!c.allergies.trim()) return 'Allergies (type "NKDA" if none)'
  if (!c.current_medications.trim()) return 'Current medications (type "None" if none)'
  if (!c.medical_history.trim()) return 'Medical history (type "None" if none)'
  if (!c.preferred_pharmacy.trim()) return 'Preferred pharmacy'
  if (!c.pcp.trim()) return 'Primary care provider'
  if (!c.vaccination_status) return 'Vaccination status'
  if (!c.self_pay) {
    if (!c.insurance_provider.trim()) return 'Insurance provider'
    if (!c.insurance_member_id.trim()) return 'Member ID'
    if (!c.insurance_group_number.trim()) return 'Group #'
    if (!c.insurance_subscriber_name.trim()) return 'Subscriber name'
    if (!c.insurance_subscriber_dob) return 'Subscriber DOB'
    if (!c.insurance_subscriber_gender) return 'Subscriber sex'
    if (!c.insurance_card_front_url) return 'Insurance card — front photo'
    if (!c.insurance_card_back_url) return 'Insurance card — back photo'
  }
  return null
}

/** Convert a validated ChildEntry into the /api/children POST payload. */
export function buildChildCreatePayload(
  child: ChildEntry,
  parent: { phone: string; email: string | null; address: string; city: string; state: string; zip: string },
): Record<string, unknown> {
  return {
    first_name:      child.first_name.trim(),
    last_name:       child.last_name.trim(),
    date_of_birth:   child.date_of_birth,
    display_label:   [child.first_name.trim(), child.last_name.trim()].filter(Boolean).join(' '),
    gender:          child.gender,
    parent_phone:    parent.phone,
    parent_email:    parent.email,
    parent_address:  parent.address,
    parent_city:     parent.city,
    parent_state:    parent.state,
    parent_zip:      parent.zip,
    allergies:                          child.allergies.trim(),
    current_medications:                child.current_medications.trim(),
    medical_history:                    child.medical_history.trim(),
    preferred_pharmacy:                 child.preferred_pharmacy.trim(),
    dosespot_pharmacy_id:               child.dosespot_pharmacy_id ?? null,
    pcp:                                child.pcp.trim(),
    vaccination_status:                 child.vaccination_status,
    insurance_provider:                 child.self_pay ? 'Self-pay' : child.insurance_provider.trim(),
    insurance_member_id:                child.self_pay ? null : child.insurance_member_id.trim(),
    insurance_group_number:             child.self_pay ? null : child.insurance_group_number.trim(),
    insurance_dependent_code:           child.self_pay ? null : (child.insurance_dependent_code?.trim() || null),
    insurance_subscriber_name:          child.self_pay ? null : child.insurance_subscriber_name.trim(),
    insurance_subscriber_dob:           child.self_pay ? null : child.insurance_subscriber_dob,
    insurance_subscriber_gender:        child.self_pay ? null : child.insurance_subscriber_gender,
    insurance_subscriber_relationship:  child.self_pay ? null : child.insurance_subscriber_relationship,
    insurance_card_front_url:           child.self_pay ? null : child.insurance_card_front_url,
    insurance_card_back_url:            child.self_pay ? null : child.insurance_card_back_url,
  }
}

export function ChildIntakeForm({
  index, child, removable, uploadCard, searchPharmacies, defaultZip, defaultState, headerLabel,
  onField, onRemove, onConfirmMatch, onDismissMatch,
}: {
  index?: number
  child: ChildEntry
  removable: boolean
  /** Uploader supplied by caller — family surfaces pass a family-auth
   * upload, provider surfaces pass a provider-auth upload. This keeps
   * the intake form usable from every ingest path. */
  uploadCard: (file: File, side: 'front' | 'back') => Promise<string>
  /** Pharmacy directory search — family surfaces pass familySearchPharmacies,
   *  provider surfaces pass searchPharmacies. Same DoseSpot endpoint, just
   *  different token. */
  searchPharmacies: (q: string, zip: string, state: string) => Promise<{ items: import('../lib/api').PharmacyMatch[] }>
  /** Family address defaults for the pharmacy search's zip / state fields. */
  defaultZip?: string
  defaultState?: string
  headerLabel?: string
  onField: (k: keyof ChildEntry, v: string | boolean | number | null) => void
  onRemove: () => void
  onConfirmMatch: () => void
  onDismissMatch: () => void
}) {
  const showMatch = child.match && !child.matchDismissed

  // Adapt the ChildEntry state to the InsuranceValue shape the shared
  // InsuranceEditor expects. onChange fans a patch back into onField.
  const insuranceValue: InsuranceValue = {
    self_pay: child.self_pay,
    insurance_provider: child.insurance_provider,
    insurance_member_id: child.insurance_member_id,
    insurance_group_number: child.insurance_group_number,
    insurance_dependent_code: child.insurance_dependent_code,
    insurance_subscriber_name: child.insurance_subscriber_name,
    insurance_subscriber_dob: child.insurance_subscriber_dob,
    insurance_subscriber_gender: child.insurance_subscriber_gender,
    insurance_subscriber_relationship: child.insurance_subscriber_relationship,
    insurance_card_front_url: child.insurance_card_front_url,
    insurance_card_back_url: child.insurance_card_back_url,
  }
  function patchInsurance(patch: Partial<InsuranceValue>) {
    for (const [k, v] of Object.entries(patch)) {
      onField(k as keyof ChildEntry, v as string | boolean)
    }
  }

  const header = headerLabel ?? (typeof index === 'number' ? `Child ${index + 1}` : 'Child')

  return (
    <div className="border border-[#E8E8E4] rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-[15px] font-medium text-[#1A1A2E]">{header}</h3>
        {removable && (
          <button onClick={onRemove} className="text-[#1A1A2E] hover:text-[#791F1F]" title="Remove">
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {/* Identity */}
      <div className="grid grid-cols-2 gap-2">
        <Input label="First name *" placeholder="Emma"
          value={child.first_name} onChange={e => onField('first_name', e.target.value)} />
        <Input label="Last name *" placeholder="Smith"
          value={child.last_name} onChange={e => onField('last_name', e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input label="Date of birth *" type="date"
          value={child.date_of_birth} onChange={e => onField('date_of_birth', e.target.value)} />
        <div>
          <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Sex *</label>
          <select value={child.gender} onChange={e => onField('gender', e.target.value)}
            className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] bg-white">
            <option value="">Select</option>
            <option value="M">Male</option>
            <option value="F">Female</option>
          </select>
        </div>
      </div>

      {showMatch && !child.matchConfirmed && (
        <div className="rounded-xl border border-[#7F77DD] bg-[#EEEDFE] p-4 space-y-3">
          <p className="text-[13px] font-semibold text-[#3C3489]">We found an existing patient profile — is this your child?</p>
          <div className="space-y-1 text-[13px] text-[#1A1A2E]">
            <div><span className="text-[#555]">Name: </span><strong>{child.match!.first_name} {child.match!.last_name}</strong></div>
            <div><span className="text-[#555]">DOB: </span><strong>{format(parseISO(String(child.match!.date_of_birth).split('T')[0]), 'MMMM d, yyyy')}</strong></div>
            {child.match!.parent_phone && <div><span className="text-[#555]">Phone: </span><strong>{child.match!.parent_phone}</strong></div>}
            {child.match!.parent_email && <div><span className="text-[#555]">Email: </span><strong>{child.match!.parent_email}</strong></div>}
          </div>
          <div className="flex gap-2 pt-1">
            <Button variant="primary" size="sm" onClick={onConfirmMatch}>
              <CheckCircle2 size={13} /> Yes, that's my child
            </Button>
            <Button variant="secondary" size="sm" onClick={onDismissMatch}>
              No, create new profile
            </Button>
          </div>
        </div>
      )}

      {/* Clinical */}
      <div className="border-t border-[#F1EFE8] pt-3 space-y-3">
        <p className="text-[11px] font-semibold text-[#7F77DD] uppercase tracking-wider">Medical</p>
        <div>
          <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Drug &amp; food allergies *</label>
          <textarea rows={2} placeholder='Type "NKDA" if none'
            value={child.allergies} onChange={e => onField('allergies', e.target.value)}
            className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] resize-none" />
        </div>
        <div>
          <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Current medications *</label>
          <textarea rows={2} placeholder='Type "None" if none'
            value={child.current_medications} onChange={e => onField('current_medications', e.target.value)}
            className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] resize-none" />
        </div>
        <div>
          <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Significant medical history *</label>
          <textarea rows={2} placeholder='Type "None" if no significant history'
            value={child.medical_history} onChange={e => onField('medical_history', e.target.value)}
            className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] resize-none" />
        </div>
        <div>
          <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Preferred pharmacy *</label>
          <PharmacyAutocomplete
            value={child.preferred_pharmacy}
            pharmacyId={child.dosespot_pharmacy_id}
            defaultZip={defaultZip ?? ''}
            defaultState={defaultState ?? ''}
            search={searchPharmacies}
            onSelect={m => {
              onField('preferred_pharmacy', m.label)
              onField('dosespot_pharmacy_id', m.dosespot_pharmacy_id)
            }}
            onClear={() => {
              onField('preferred_pharmacy', '')
              onField('dosespot_pharmacy_id', null)
            }}
          />
          <p className="text-[11px] text-[#1A1A2E]/60 mt-1">
            Search by pharmacy name and zip. Picking a specific store guarantees your child's
            e-prescriptions go to the exact right pharmacy.
          </p>
        </div>
        <div>
          <Input label="Primary care provider *" placeholder="Dr. Jane Smith"
            value={child.pcp} onChange={e => onField('pcp', e.target.value)} />
        </div>
        <div>
          <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Vaccination status *</label>
          <select value={child.vaccination_status} onChange={e => onField('vaccination_status', e.target.value)}
            className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] bg-white">
            <option value="">Select</option>
            {VAX_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {/* Insurance — delegated to shared InsuranceEditor */}
      <div className="border-t border-[#F1EFE8] pt-3 space-y-3">
        <p className="text-[11px] font-semibold text-[#7F77DD] uppercase tracking-wider">Insurance</p>
        <InsuranceEditor
          value={insuranceValue}
          onChange={patchInsurance}
          uploadCard={uploadCard}
        />
      </div>
    </div>
  )
}

