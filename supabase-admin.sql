-- Run this in Supabase SQL editor to add admin support

-- Allow admin role in providers table
alter table providers drop constraint if exists providers_role_check;
alter table providers add constraint providers_role_check
  check (role in ('MD','PNP','CMA','RN','admin'));

-- Helper function to check if current user is admin
create or replace function is_admin()
returns boolean as $$
  select exists (
    select 1 from providers where id = auth.uid() and role = 'admin'
  );
$$ language sql security definer;

-- Allow admins to read all appointments
create policy "Admins read all appointments" on appointments for select
  using (is_admin());

-- Allow admins to manage all appointments
create policy "Admins manage all appointments" on appointments for all
  using (is_admin());

-- Allow admins to insert broadcasts
create policy "Admins insert broadcasts" on broadcasts for insert
  with check (auth.uid() is not null);

-- Allow admins to delete broadcasts
create policy "Admins delete broadcasts" on broadcasts for delete
  using (is_admin());

-- Insert Pam's provider record (replace USER_UID with her Supabase auth UID)
-- Run this separately after creating her auth account:
-- insert into providers (id, name, role, initials, zones, states, avatar_color, avatar_text_color)
-- values ('USER_UID', 'Pam Tarnowski', 'admin', 'PT', array[]::text[], array[]::text[], '#F1EFE8', '#888780');
