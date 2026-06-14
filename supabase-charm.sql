-- Charm Health integration schema additions
-- Run in Supabase SQL editor

-- Add Charm patient ID to children (each child is a separate Charm patient)
alter table children add column if not exists charm_patient_id text;

-- Add Charm appointment ID to booking requests
alter table booking_requests add column if not exists charm_appointment_id text;

-- Add insurance fields to family profiles
alter table family_profiles
  add column if not exists insurance_provider text,
  add column if not exists insurance_member_id text,
  add column if not exists insurance_group_number text,
  add column if not exists insurance_subscriber_name text,
  add column if not exists preferred_pharmacy text,
  add column if not exists charm_synced_at timestamptz;
