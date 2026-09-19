-- Repair: ensure the profile preference columns exist and refresh the API schema cache.
-- Run this if profile sync fails with:
--   "Could not find the 'profile_context' column of 'profiles' in the schema cache"
-- Safe to run multiple times.

alter table public.profiles add column if not exists profile_context text;
alter table public.profiles add column if not exists profile_tags jsonb not null default '[]'::jsonb;

-- These were required at first; make sure they are optional so upserts don't fail.
alter table public.profiles alter column username drop not null;
alter table public.profiles alter column birth_year drop not null;

-- Force PostgREST (the Supabase data API) to reload its schema cache right away.
notify pgrst, 'reload schema';
