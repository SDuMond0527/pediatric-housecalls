// Central rule for what a "complete" patient chart requires. Any place that
// touches a patient (family portal login, booking, waitlist submit, admin
// booking, chart open, encounter note open) uses this to decide whether the
// record has enough data to proceed. If it returns anything, the flow MUST
// prompt for the missing fields before continuing.
//
// See memory: feedback_all_patient_info_required_and_displayed.md

export interface RequiredField {
  key: string
  label: string
  section: 'Identity' | 'Contact' | 'Clinical' | 'Insurance' | 'Cards' | 'Consent'
  scope: 'always' | 'if-not-self-pay'
}

export const REQUIRED_CHILD_FIELDS: RequiredField[] = [
  { key: 'first_name',                     label: "Child's first name",        section: 'Identity', scope: 'always' },
  { key: 'last_name',                      label: "Child's last name",         section: 'Identity', scope: 'always' },
  { key: 'date_of_birth',                  label: 'Date of birth',             section: 'Identity', scope: 'always' },
  { key: 'gender',                         label: 'Sex',                       section: 'Identity', scope: 'always' },
  { key: 'parent_phone',                   label: 'Parent phone',              section: 'Contact',  scope: 'always' },
  { key: 'parent_email',                   label: 'Parent email',              section: 'Contact',  scope: 'always' },
  { key: 'parent_address',                 label: 'Home address',              section: 'Contact',  scope: 'always' },
  { key: 'allergies',                      label: 'Drug & food allergies',     section: 'Clinical', scope: 'always' },
  { key: 'current_medications',            label: 'Current medications',       section: 'Clinical', scope: 'always' },
  { key: 'medical_history',                label: 'Medical history (PMH)',     section: 'Clinical', scope: 'always' },
  { key: 'preferred_pharmacy',             label: 'Preferred pharmacy',        section: 'Clinical', scope: 'always' },
  { key: 'pcp',                            label: 'Primary care provider',     section: 'Clinical', scope: 'always' },
  { key: 'vaccination_status',             label: 'Vaccination status',        section: 'Clinical', scope: 'always' },
  { key: 'insurance_provider',             label: 'Insurance provider',        section: 'Insurance', scope: 'if-not-self-pay' },
  { key: 'insurance_member_id',            label: 'Member ID',                 section: 'Insurance', scope: 'if-not-self-pay' },
  { key: 'insurance_group_number',         label: 'Group #',                   section: 'Insurance', scope: 'if-not-self-pay' },
  { key: 'insurance_subscriber_name',      label: 'Subscriber name',           section: 'Insurance', scope: 'if-not-self-pay' },
  { key: 'insurance_subscriber_dob',       label: 'Subscriber DOB',            section: 'Insurance', scope: 'if-not-self-pay' },
  { key: 'insurance_subscriber_gender',    label: 'Subscriber sex',            section: 'Insurance', scope: 'if-not-self-pay' },
  { key: 'insurance_card_front_url',       label: 'Insurance card — front',    section: 'Cards',     scope: 'if-not-self-pay' },
  { key: 'insurance_card_back_url',        label: 'Insurance card — back',     section: 'Cards',     scope: 'if-not-self-pay' },
]

/** Non-empty test that also treats whitespace-only strings as empty. */
function isEmpty(v: unknown): boolean {
  if (v == null) return true
  if (typeof v === 'string') return v.trim() === ''
  return false
}

/**
 * Return every required field the given child record is missing. Empty
 * array means the record is complete. `parent_phone` / `parent_email` /
 * `parent_address` also fall back to the linked family_profile if that's
 * where the value lives, so a child whose data is fully populated on the
 * family row doesn't get falsely flagged.
 */
export function getMissingChildFields(
  child: Record<string, any> | null | undefined,
  family?: Record<string, any> | null,
): RequiredField[] {
  if (!child) return REQUIRED_CHILD_FIELDS
  const isSelfPay = String(child.insurance_provider || '').toLowerCase() === 'self-pay'
  const familyFallback: Record<string, unknown> = {
    parent_phone:   family?.phone,
    parent_email:   family?.email,
    parent_address: family?.address_line1,
  }
  return REQUIRED_CHILD_FIELDS.filter(f => {
    if (f.scope === 'if-not-self-pay' && isSelfPay) return false
    // PCP is satisfied by EITHER the free-text `pcp` column OR a
    // `pcp_id` reference to the pcps table. The patient chart display
    // resolves via pcp_id first, so a chart that visually shows a
    // pediatric practice name may have empty child.pcp.
    if (f.key === 'pcp' && !isEmpty(child.pcp_id)) return false
    const own = child[f.key]
    const fam = familyFallback[f.key]
    return isEmpty(own) && isEmpty(fam)
  })
}

export function isChildComplete(
  child: Record<string, any> | null | undefined,
  family?: Record<string, any> | null,
): boolean {
  return getMissingChildFields(child, family).length === 0
}
