-- Roam Platform — Neon Schema
-- Run this in the Neon SQL editor

-- Providers (id = Cognito sub UUID)
create table if not exists providers (
  id uuid primary key,
  cognito_sub text unique not null,
  name text not null,
  role text not null check (role in ('MD','PNP','CMA','RN','admin')),
  initials text not null,
  zones text[] not null default '{}',
  states text[] not null default '{}',
  avatar_color text not null default '#EEEDFE',
  avatar_text_color text not null default '#3C3489',
  is_active boolean not null default true,
  is_admin boolean not null default false,
  is_super_admin boolean not null default false,
  phone text,
  email text,
  home_address text,
  secure_text_number text,
  created_at timestamptz default now()
);

-- Appointments
create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid references providers(id) on delete cascade not null,
  visit_type text not null,
  zone text not null,
  scheduled_time text not null,
  scheduled_date date not null,
  status text not null default 'upcoming' check (status in ('upcoming','in-progress','done','cancelled')),
  notes text,
  after_visit_instructions text,
  duration_minutes int,
  charm_appointment_id text,
  charm_patient_id text,
  created_at timestamptz default now()
);

-- Availability
create table if not exists availability (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid references providers(id) on delete cascade not null,
  day_of_week int not null check (day_of_week between 0 and 6),
  is_active boolean not null default true,
  start_time text not null default '08:00',
  end_time text not null default '17:00',
  unique (provider_id, day_of_week)
);

-- Availability overrides (date-specific)
create table if not exists availability_overrides (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid references providers(id) on delete cascade not null,
  date date not null,
  is_available boolean not null default true,
  start_time text,
  end_time text,
  note text,
  created_at timestamptz default now(),
  unique(provider_id, date)
);

-- Zone restrictions
create table if not exists zone_restrictions (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid references providers(id) on delete cascade not null,
  zone text not null,
  start_time text not null,
  end_time text not null
);

-- Time blocks
create table if not exists time_blocks (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid references providers(id) on delete cascade not null,
  label text not null,
  days text not null,
  time_range text not null
);

-- Visit type availability
create table if not exists visit_type_availability (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid references providers(id) on delete cascade not null,
  visit_type text not null,
  is_active boolean not null default true,
  start_time text not null default '08:00',
  end_time text not null default '17:00',
  unique (provider_id, visit_type)
);

-- Broadcasts
create table if not exists broadcasts (
  id uuid primary key default gen_random_uuid(),
  patient_first_name text,
  patient_last_name text,
  patient_dob text,
  patient_address text,
  zone text,
  state text,
  visit_type text,
  request_type text not null default 'standard',
  complaint text,
  is_urgent boolean not null default false,
  is_open boolean not null default true,
  created_by uuid references providers(id),
  created_by_name text,
  created_at timestamptz default now()
);

-- Family profiles (id = Cognito sub UUID)
create table if not exists family_profiles (
  id uuid primary key,
  cognito_sub text unique not null,
  email text not null,
  display_name text,
  phone text,
  address_line1 text,
  city text,
  state text check (state in ('NC','SC','VA')),
  zip text,
  charm_family_id text,
  charm_synced_at timestamptz,
  square_customer_id text,
  square_card_id text,
  referral_source text,
  agreements_accepted_at timestamptz,
  payment_policy_accepted_at timestamptz,
  created_at timestamptz default now()
);

-- Children
create table if not exists children (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references family_profiles(id) on delete cascade not null,
  display_label text not null,
  charm_patient_id text,
  dosespot_patient_id int,
  first_name text,
  last_name text,
  date_of_birth date,
  insurance_provider text,
  insurance_member_id text,
  insurance_group_number text,
  insurance_card_front_url text,
  insurance_card_back_url text,
  gender text,
  insurance_subscriber_name text,
  insurance_subscriber_dob date,
  insurance_subscriber_gender text,
  allergies text,
  current_medications text,
  medical_history text,
  preferred_pharmacy text,
  pcp text,
  phi_sharing_consent boolean,
  created_at timestamptz default now()
);

-- Booking requests
create table if not exists booking_requests (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references family_profiles(id) on delete cascade not null,
  child_ids uuid[] not null default '{}',
  visit_type text not null,
  preferred_provider text,
  zone text,
  state text,
  preferred_date date not null,
  preferred_time text not null,
  status text not null default 'pending' check (status in ('pending','confirmed','cancelled')),
  confirmed_provider_id uuid references providers(id),
  charm_appointment_id text,
  reference_code text not null,
  convenience_fee numeric,
  notes text,
  created_at timestamptz default now()
);

-- Waitlist entries
create table if not exists waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references family_profiles(id) on delete cascade not null,
  child_ids uuid[] not null default '{}',
  visit_type text,
  zip text,
  zone text,
  state text,
  preferred_time_window text,
  complaint text,
  status text not null default 'waiting' check (status in ('waiting','contacted','offered','converted','removed')),
  converted_provider_id uuid references providers(id),
  notes text,
  created_at timestamptz default now()
);

-- PHI Audit Log (HIPAA access tracking)
create table if not exists phi_audit_log (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid references providers(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id text,
  created_at timestamptz default now()
);
create index if not exists phi_audit_log_provider_idx on phi_audit_log(provider_id);
create index if not exists phi_audit_log_resource_idx on phi_audit_log(resource_type, resource_id);
create index if not exists phi_audit_log_created_idx  on phi_audit_log(created_at);

-- Slot offers (waitlist → family)
create table if not exists slot_offers (
  id uuid primary key default gen_random_uuid(),
  waitlist_entry_id uuid references waitlist_entries(id) on delete cascade not null,
  provider_id uuid references providers(id) not null,
  provider_name text not null,
  visit_type text,
  offered_date date not null,
  offered_time text not null,
  zone text,
  status text not null default 'pending' check (status in ('pending','accepted','declined','expired')),
  expires_at timestamptz not null,
  created_at timestamptz default now()
);
