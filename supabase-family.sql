-- Family portal schema -- run in Supabase SQL editor

-- Family profiles (linked to auth.users)
create table if not exists family_profiles (
  id uuid references auth.users primary key,
  guardian_first text not null,
  guardian_last text not null,
  phone text not null,
  email text not null,
  address text,
  state text check (state in ('NC','SC','VA')),
  zip text,
  created_at timestamptz default now()
);
alter table family_profiles enable row level security;
create policy "Families manage own profile" on family_profiles for all using (auth.uid() = id);
create policy "Admins read all family profiles" on family_profiles for select using (is_admin());

-- Children
create table if not exists children (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references family_profiles(id) on delete cascade not null,
  first_name text not null,
  last_name text not null,
  date_of_birth date not null,
  created_at timestamptz default now()
);
alter table children enable row level security;
create policy "Families manage own children" on children for all
  using (exists (select 1 from family_profiles where family_profiles.id = children.family_id and family_profiles.id = auth.uid()));
create policy "Admins read all children" on children for select using (is_admin());

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
  complaints jsonb default '{}',
  vaccination_status text check (vaccination_status in ('fully_vaccinated','delayed','unvaccinated')),
  notes text,
  status text not null default 'pending' check (status in ('pending','confirmed','cancelled')),
  confirmed_provider_id uuid references providers(id),
  reference_code text not null,
  created_at timestamptz default now()
);
alter table booking_requests enable row level security;
create policy "Families read own bookings" on booking_requests for select
  using (auth.uid() = family_id);
create policy "Families insert bookings" on booking_requests for insert
  with check (auth.uid() = family_id);
create policy "Families cancel own bookings" on booking_requests for update
  using (auth.uid() = family_id);
create policy "Admins manage all bookings" on booking_requests for all using (is_admin());
create policy "Providers read own bookings" on booking_requests for select
  using (confirmed_provider_id = auth.uid());
