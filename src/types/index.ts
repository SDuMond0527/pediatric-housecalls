export type Role = 'MD' | 'PNP' | 'CMA' | 'RN' | 'admin'

export interface Provider {
  id: string
  name: string
  role: Role
  initials: string
  zones: string[]
  states: string[]
  avatar_color: string
  avatar_text_color: string
  is_active: boolean
  is_admin: boolean
  is_super_admin: boolean
  practice_id: string
  created_at: string
}

export interface Appointment {
  id: string
  provider_id: string
  visit_type: VisitType
  zone: string
  scheduled_time: string
  scheduled_date: string
  status: 'upcoming' | 'in-progress' | 'done' | 'cancelled'
  charm_appointment_id: string | null
  charm_patient_id: string | null
  notes: string | null
  after_visit_instructions: string | null
  duration_minutes: number | null
  created_at: string
}

export type VisitType =
  | 'In-home sick visit'
  | 'Video telemedicine'
  | 'Sports physical'
  | 'CMA + telemedicine'
  | 'Text visit'
  | 'In-home IV fluids'
  | 'In-home CPR class (Heartsaver)'
  | 'In-home CPR class (BLS)'

export interface Availability {
  id: string
  provider_id: string
  day_of_week: number
  is_active: boolean
  start_time: string
  end_time: string
}

export interface ZoneRestriction {
  id: string
  provider_id: string
  zone: string
  start_time: string
  end_time: string
}

export interface TimeBlock {
  id: string
  provider_id: string
  label: string
  days: string
  time_range: string
}

export interface Broadcast {
  id: string
  patient_first_name: string
  patient_last_name: string
  patient_dob: string | null
  patient_address: string | null
  zone: string | null
  state: string | null
  visit_type: string | null
  request_type: string
  complaint: string | null
  is_urgent: boolean
  is_open: boolean
  created_by: string | null
  created_by_name: string | null
  created_at: string
}
