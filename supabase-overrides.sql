-- Date-specific availability overrides
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
alter table availability_overrides enable row level security;
create policy "Providers manage own overrides" on availability_overrides for all
  using (auth.uid() = provider_id);
create policy "Admins read all overrides" on availability_overrides for select
  using (is_admin());
