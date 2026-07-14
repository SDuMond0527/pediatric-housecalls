export interface FamilyProfile {
  id: string
  email: string
  display_name: string | null
  phone: string | null
  address_line1: string | null
  city: string | null
  state: 'NC' | 'SC' | 'VA' | null
  zip: string | null
  charm_family_id: string | null
  charm_synced_at: string | null
  square_customer_id: string | null
  square_card_id: string | null
  created_at: string
}

export interface Child {
  id: string
  family_id: string
  display_label: string
  charm_patient_id: string | null
  first_name: string | null
  last_name: string | null
  date_of_birth: string | null
  insurance_provider: string | null
  insurance_member_id: string | null
  insurance_group_number: string | null
  insurance_card_front_url: string | null
  insurance_card_back_url: string | null
  allergies: string | null
  current_medications: string | null
  medical_history: string | null
  preferred_pharmacy: string | null
  pcp: string | null
  pcp_id: string | null
  created_at: string
}

export interface SlotOffer {
  id: string
  waitlist_entry_id: string
  provider_id: string
  provider_name: string
  visit_type: string | null
  offered_date: string
  offered_time: string
  zone: string | null
  status: 'pending' | 'accepted' | 'declined' | 'expired'
  created_at: string
  expires_at: string
}

export interface BookingRequest {
  id: string
  family_id: string
  child_ids: string[]
  visit_type: string
  preferred_provider: string | null
  zone: string | null
  state: string | null
  preferred_date: string
  preferred_time: string
  status: 'pending' | 'confirmed' | 'cancelled'
  confirmed_provider_id: string | null
  charm_appointment_id: string | null
  reference_code: string
  created_at: string
}
