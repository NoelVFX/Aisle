-- Repair profile RLS after an older schema/policy setup.
-- Run this in the Supabase SQL Editor (or apply it with the Supabase CLI).
-- Safe to run repeatedly. The client only ever writes the signed-in user's row.

alter table if exists public.profiles enable row level security;

-- Recreate the policies used by /api/profile. The INSERT policy is required for
-- users whose auth trigger did not create a profile row.
drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Make the new columns visible to PostgREST immediately.
notify pgrst, 'reload schema';
