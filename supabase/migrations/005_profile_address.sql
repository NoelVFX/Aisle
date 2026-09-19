-- Add an optional delivery/location address to profiles.
-- Run this in the Supabase SQL editor. Safe to run multiple times.

alter table public.profiles add column if not exists profile_address text;

-- Force PostgREST (the Supabase data API) to reload its schema cache right away,
-- so saving the address does not fail with "Could not find the 'profile_address'
-- column of 'profiles' in the schema cache".
notify pgrst, 'reload schema';
