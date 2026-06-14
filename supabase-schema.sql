-- Pediatric Housecalls Provider Portal Schema
-- Run this in your Supabase SQL editor

-- Providers (linked to auth.users)
create table if not exists providers (
  id uuid references auth.users primary key,
  name text not null,
  role text not null check (role in ('MD','PNP','CMA','RN')),
  initials text not null,
  zones text[] not null default '{}',
  states text[] not null default '{}',
  avatar_color text not null default '#EEEDFE',
  avatar_text_color text not null default '#3C3489',
  is_active boolean not null default true,
  created_at timestamptz default now()
);
alter table providers enable row level security;
create policy "Providers read all" on providers for select using (auth.uid() is not null);
create policy "Providers update own" on providers for update using (auth.uid() = id);

-- Appointments
create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid references providers(id) on delete cascade not null,
  patient_name text not null,
  patient_age text not null,
  visit_type text not null,
  zone text not null,
  complaint text not null,
  insurance text not null,
  address text,
  pcp text,
  allergies text not null default 'NKDA',
  scheduled_time text not null,
  scheduled_date date not null,
  status text not null default 'upcoming' check (status in ('upcoming','in-progress','done')),
  notes text,
  created_at timestamptz default now()
);
alter table appointments enable row level security;
create policy "Providers read own appointments" on appointments for select
  using (auth.uid() = provider_id);
create policy "Providers manage own appointments" on appointments for all
  using (auth.uid() = provider_id);

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
alter table availability enable row level security;
create policy "Providers manage own availability" on availability for all
  using (auth.uid() = provider_id);

-- Zone restrictions
create table if not exists zone_restrictions (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid references providers(id) on delete cascade not null,
  zone text not null,
  start_time text not null,
  end_time text not null
);
alter table zone_restrictions enable row level security;
create policy "Providers manage own zone restrictions" on zone_restrictions for all
  using (auth.uid() = provider_id);

-- Time blocks
create table if not exists time_blocks (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid references providers(id) on delete cascade not null,
  label text not null,
  days text not null,
  time_range text not null
);
alter table time_blocks enable row level security;
create policy "Providers manage own time blocks" on time_blocks for all
  using (auth.uid() = provider_id);

-- Broadcasts
create table if not exists broadcasts (
  id uuid primary key default gen_random_uuid(),
  patient_name text not null,
  patient_age text not null,
  zone text not null,
  visit_type text not null,
  complaint text not null,
  requested_time text not null,
  distance text not null,
  is_urgent boolean not null default false,
  is_open boolean not null default true,
  created_at timestamptz default now()
);
alter table broadcasts enable row level security;
create policy "All providers read broadcasts" on broadcasts for select
  using (auth.uid() is not null);
create policy "All providers update broadcasts" on broadcasts for update
  using (auth.uid() is not null);

-- Sample broadcasts
insert into broadcasts (patient_name, patient_age, zone, visit_type, complaint, requested_time, distance, is_urgent)
values
  ('Tyler Morris', '7y', 'Waxhaw / Weddington / Marvin', 'In-home sick visit', 'High fever — 103.2°F', '2:30 PM today', '4.2 mi', true),
  ('Zoe Patel', '4y', 'Cotswold / SouthPark', 'In-home IV fluids', 'Vomiting for 18 hrs, not keeping fluids down', '3:00 PM today', '6.8 mi', true),
  ('Marcus Lee', '11y', 'Ballantyne / Providence', 'Video telemedicine', 'Follow-up on strep treatment', 'Any time today', 'Tele', false);
