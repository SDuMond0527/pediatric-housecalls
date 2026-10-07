import { useState } from 'react'
import { Upload } from 'lucide-react'
import { Input } from './ui/Input'

// Single source of truth for the "Insurance" editor block used across
// signup / add-child / chart edit forms. Self-pay toggle hides all
// insurance fields when checked. Card photos require an uploadCard
// callback from the caller (family-auth in family surfaces, provider
// -auth pre-child helper in provider surfaces).
//
// See memory: feedback_extract_shared_code_first_try.md — this block
// was duplicated across at least 4 places and drifted repeatedly
// (self-pay was in BookVisit only, PP mapping was missing in one
// claims path, etc.). Every future insurance UI change happens HERE.

export type InsuranceValue = {
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
}

export function emptyInsurance(): InsuranceValue {
  return {
    self_pay: false,
    insurance_provider: '',
    insurance_member_id: '',
    insurance_group_number: '',
    insurance_dependent_code: '',
    insurance_subscriber_name: '',
    insurance_subscriber_dob: '',
    insurance_subscriber_gender: '',
    insurance_subscriber_relationship: 'Child',
    insurance_card_front_url: '',
    insurance_card_back_url: '',
  }
}

/** BCBS NC requires a 2-digit dependent suffix on the member ID. Show the extra field whenever the provider string reads as any BCBS variant. */
export function looksLikeBcbs(providerValue?: string | null): boolean {
  const v = String(providerValue || '').toLowerCase()
  return v.includes('bcbs') || v.includes('blue cross')
}

// Canonical insurance provider dropdown — matches the AR aging report
// and the Stedi payer resolver (api/claims/index.ts). Entering a canonical
// name here means every downstream (payer_id lookup, claim submit,
// aging report grouping) matches cleanly without string drift. "Other"
// reveals a free-text fallback for anything we don't carry in the list.
// Keep the labels in sync with the resolver so new payers don't vanish.
// Sara 2026-10-07.
export const INSURANCE_PROVIDERS = [
  'BCBS of NC',
  'Anthem BCBS of Virginia',
  'United Healthcare',
  'UMR',
  'Aetna',
  'Cigna',
  'Humana',
  'PHCS / Multiplan',
  'Coventry',
  'Select Health',
  'Medcost / Healthgram',
  'Bright Health',
] as const

const OTHER_SENTINEL = '__other__'

/** Map a stored (possibly messy) insurance_provider string to a canonical
 *  dropdown value, or OTHER_SENTINEL if it doesn't match a known family.
 *  Handles legacy records entered as free text (BCBS, Blue Cross NC,
 *  UHC, Aetna, etc.). */
function matchCanonicalProvider(raw: string): string {
  const v = String(raw || '').toLowerCase().trim()
  if (!v) return ''
  if (/anthem/.test(v) && /\b(va|virginia)\b/.test(v)) return 'Anthem BCBS of Virginia'
  if (/anthem/.test(v))                                return 'BCBS of NC'
  if (/\bbcbs\b|blue\s*cross|blue\s*shield/.test(v))   return 'BCBS of NC'
  if (/\bumr\b/.test(v))                               return 'UMR'
  if (/united\s*health|\buhc\b/.test(v))               return 'United Healthcare'
  if (/cigna/.test(v))                                 return 'Cigna'
  if (/aetna/.test(v))                                 return 'Aetna'
  if (/humana/.test(v))                                return 'Humana'
  if (/phcs|multiplan/.test(v))                        return 'PHCS / Multiplan'
  if (/coventry/.test(v))                              return 'Coventry'
  if (/select\s*health/.test(v))                       return 'Select Health'
  if (/medcost|healthgram/.test(v))                    return 'Medcost / Healthgram'
  if (/bright\s*health/.test(v))                       return 'Bright Health'
  return OTHER_SENTINEL
}

/** Detect self-pay from any of the common spellings for the provider value. */
export function detectSelfPay(providerValue?: string | null): boolean {
  const v = String(providerValue || '').toLowerCase().trim()
  return v === 'self-pay' || v === 'selfpay' || v === 'self pay' || v === 'self'
}

/** Return the label of the first missing required field, or null if complete. */
export function insuranceIsComplete(v: InsuranceValue, opts?: { requireCards?: boolean }): string | null {
  if (v.self_pay) return null
  if (!v.insurance_provider.trim()) return 'Insurance provider'
  if (!v.insurance_member_id.trim()) return 'Member ID'
  if (!v.insurance_group_number.trim()) return 'Group #'
  const subName = v.insurance_subscriber_name.trim()
  if (!subName) return 'Subscriber name'
  // Payer 837P requires both first and last name for the subscriber.
  // A single-word entry (e.g., "Rodgers") passes the not-empty check
  // but Blue Cross rejects at Stedi with code 33 "Missing First Name."
  // Catch it here so it can never reach the claim submitter.
  if (subName.split(/\s+/).filter(Boolean).length < 2) return 'Subscriber first AND last name'
  if (!v.insurance_subscriber_dob) return 'Subscriber DOB'
  if (!v.insurance_subscriber_gender) return 'Subscriber sex'
  if (opts?.requireCards !== false) {
    if (!v.insurance_card_front_url) return 'Insurance card — front photo'
    if (!v.insurance_card_back_url) return 'Insurance card — back photo'
  }
  return null
}

/** Turn a validated InsuranceValue into API-payload fields. */
export function insurancePayload(v: InsuranceValue): Record<string, unknown> {
  return {
    insurance_provider:                v.self_pay ? 'Self-pay' : v.insurance_provider.trim(),
    insurance_member_id:               v.self_pay ? null : v.insurance_member_id.trim(),
    insurance_group_number:            v.self_pay ? null : v.insurance_group_number.trim(),
    insurance_dependent_code:          v.self_pay ? null : (v.insurance_dependent_code?.trim() || null),
    insurance_subscriber_name:         v.self_pay ? null : v.insurance_subscriber_name.trim(),
    insurance_subscriber_dob:          v.self_pay ? null : v.insurance_subscriber_dob,
    insurance_subscriber_gender:       v.self_pay ? null : v.insurance_subscriber_gender,
    insurance_subscriber_relationship: v.self_pay ? null : v.insurance_subscriber_relationship,
    insurance_card_front_url:          v.self_pay ? null : v.insurance_card_front_url,
    insurance_card_back_url:           v.self_pay ? null : v.insurance_card_back_url,
  }
}

export function InsuranceEditor({
  value, onChange, uploadCard, showCards = true, showSubscriber = true,
}: {
  value: InsuranceValue
  onChange: (patch: Partial<InsuranceValue>) => void
  uploadCard?: (file: File, side: 'front' | 'back') => Promise<string>
  showCards?: boolean
  showSubscriber?: boolean
}) {
  const [uploadingFront, setUploadingFront] = useState(false)
  const [uploadingBack, setUploadingBack] = useState(false)
  const [uploadErr, setUploadErr] = useState('')

  async function doUpload(file: File, side: 'front' | 'back') {
    if (!uploadCard) return
    setUploadErr('')
    if (side === 'front') setUploadingFront(true); else setUploadingBack(true)
    try {
      const url = await uploadCard(file, side)
      onChange(side === 'front' ? { insurance_card_front_url: url } : { insurance_card_back_url: url })
    } catch (e: any) {
      setUploadErr(e?.message || 'Upload failed')
    } finally {
      if (side === 'front') setUploadingFront(false); else setUploadingBack(false)
    }
  }

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2 p-3 border border-[#E8E8E4] rounded-lg cursor-pointer hover:bg-[#FAFAF8]">
        <input type="checkbox" checked={value.self_pay}
          onChange={e => onChange({ self_pay: e.target.checked })}
          className="mt-0.5" />
        <div>
          <div className="text-[13px] font-medium text-[#1A1A2E]">Self-pay (no insurance)</div>
          <div className="text-[11px] text-[#1A1A2E]">Check this if the family isn't filing insurance.</div>
        </div>
      </label>

      {!value.self_pay && (
        <>
          <div className="grid grid-cols-2 gap-2">
            {/* Insurance provider dropdown. Picks the exact canonical
                name so downstream payer resolver + aging report group
                cleanly. Legacy free-text entries get mapped on load; if
                we can't map, the "Other" option reveals a free-text
                field so we never block anyone whose insurance isn't in
                the list. Sara 2026-10-07. */}
            {(() => {
              const canonical = matchCanonicalProvider(value.insurance_provider)
              const dropdownValue = canonical === OTHER_SENTINEL ? OTHER_SENTINEL
                                  : canonical
              return (
                <div>
                  <label className="text-[11px] font-medium text-[#1A1A2E] block mb-1">Insurance provider *</label>
                  <select
                    className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD] bg-white"
                    value={dropdownValue}
                    onChange={e => {
                      const v = e.target.value
                      if (v === '') onChange({ insurance_provider: '' })
                      else if (v === OTHER_SENTINEL) {
                        // Preserve any existing free-text on switch to Other.
                        onChange({ insurance_provider: canonical === OTHER_SENTINEL ? value.insurance_provider : '' })
                      } else {
                        onChange({ insurance_provider: v })
                      }
                    }}
                  >
                    <option value="">— Choose insurance —</option>
                    {INSURANCE_PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
                    <option value={OTHER_SENTINEL}>Other (type below)</option>
                  </select>
                  {dropdownValue === OTHER_SENTINEL && (
                    <input
                      type="text"
                      className="mt-1 w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                      placeholder="Type the insurance company name"
                      value={value.insurance_provider}
                      onChange={e => onChange({ insurance_provider: e.target.value })}
                    />
                  )}
                </div>
              )
            })()}
            <Input label="Member ID *" placeholder="ABC123456"
              value={value.insurance_member_id}
              onChange={e => onChange({ insurance_member_id: e.target.value })} />
          </div>

          <Input label="Group # *" placeholder="G00000001"
            value={value.insurance_group_number}
            onChange={e => onChange({ insurance_group_number: e.target.value })} />

          {looksLikeBcbs(value.insurance_provider) && (
            <div>
              <Input label="Dependent code (BCBS NC) — 2 digits"
                placeholder="e.g. 03"
                maxLength={2}
                value={value.insurance_dependent_code}
                onChange={e => onChange({ insurance_dependent_code: e.target.value.replace(/\D/g, '').slice(0, 2) })} />
              <p className="text-[10px] text-[#1A1A2E] mt-1">Required for BCBS NC. 01=subscriber, 02=spouse, 03+=kids by DOB. Check EOB or call BCBS NC.</p>
            </div>
          )}

          {showSubscriber && (
            <>
              <Input label="Subscriber full name (first AND last) *" placeholder="e.g., Sarah Rodgers"
                value={value.insurance_subscriber_name}
                onChange={e => onChange({ insurance_subscriber_name: e.target.value })} />
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Subscriber DOB *</label>
                  <input type="date"
                    value={value.insurance_subscriber_dob}
                    onChange={e => onChange({ insurance_subscriber_dob: e.target.value })}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] outline-none" />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Subscriber sex *</label>
                  <select value={value.insurance_subscriber_gender}
                    onChange={e => onChange({ insurance_subscriber_gender: e.target.value })}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] bg-white">
                    <option value="">Select</option>
                    <option value="M">Male</option>
                    <option value="F">Female</option>
                  </select>
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Relationship *</label>
                  <select value={value.insurance_subscriber_relationship}
                    onChange={e => onChange({ insurance_subscriber_relationship: e.target.value })}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] bg-white">
                    <option value="Self">Self</option>
                    <option value="Spouse">Spouse</option>
                    <option value="Child">Child</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>
            </>
          )}

          {showCards && uploadCard && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <CardUpload label="Insurance card — front *"
                  url={value.insurance_card_front_url}
                  uploading={uploadingFront}
                  onFile={f => doUpload(f, 'front')}
                  onClear={() => onChange({ insurance_card_front_url: '' })} />
                <CardUpload label="Insurance card — back *"
                  url={value.insurance_card_back_url}
                  uploading={uploadingBack}
                  onFile={f => doUpload(f, 'back')}
                  onClear={() => onChange({ insurance_card_back_url: '' })} />
              </div>
              {uploadErr && <div className="text-[12px] text-[#DC2626]">{uploadErr}</div>}
            </>
          )}
        </>
      )}
    </div>
  )
}

function CardUpload({ label, url, uploading, onFile, onClear }: {
  label: string; url: string; uploading: boolean
  onFile: (f: File) => void; onClear: () => void
}) {
  return (
    <div>
      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">{label}</label>
      {url ? (
        <div className="flex items-center gap-2">
          <img src={url} className="h-16 rounded border border-[#E8E8E4] object-contain" />
          <button onClick={onClear} className="text-[11px] text-[#DC2626]">Remove</button>
        </div>
      ) : (
        <label className="flex items-center gap-1.5 px-3 py-2 border border-dashed border-[#E8E8E4] rounded-lg text-[12px] text-[#555] cursor-pointer hover:bg-[#F1EFE8]">
          <Upload size={12} />
          {uploading ? 'Uploading…' : 'Choose photo'}
          <input type="file" accept="image/*" className="hidden"
            onChange={e => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
      )}
    </div>
  )
}
