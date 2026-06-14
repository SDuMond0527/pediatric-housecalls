-- Remove PHI from Supabase — Option A implementation
-- Safe to run: no real patient data exists yet

-- family_profiles: keep only routing + auth reference
alter table family_profiles
  drop column if exists guardian_first,
  drop column if exists guardian_last,
  drop column if exists phone,
  drop column if exists address,
  drop column if exists insurance_provider,
  drop column if exists insurance_member_id,
  drop column if exists insurance_group_number,
  drop column if exists insurance_subscriber_name,
  drop column if exists preferred_pharmacy;

-- Add a self-chosen display name (e.g. "The Smith Family") — not an official name, not PHI
alter table family_profiles add column if not exists display_name text;

-- children: remove identifying info, keep a self-chosen label
alter table children
  drop column if exists first_name,
  drop column if exists last_name,
  drop column if exists date_of_birth;

alter table children add column if not exists display_label text not null default 'Child';

-- booking_requests: remove clinical details
alter table booking_requests
  drop column if exists complaints,
  drop column if exists vaccination_status,
  drop column if exists notes;

-- appointments: remove all patient-identifying fields
alter table appointments
  drop column if exists patient_name,
  drop column if exists patient_age,
  drop column if exists complaint,
  drop column if exists insurance,
  drop column if exists address,
  drop column if exists pcp,
  drop column if exists allergies;
