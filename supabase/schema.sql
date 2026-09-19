-- Run this once in the Supabase dashboard: SQL Editor → New query → paste → Run.
--
-- What it sets up:
--   1. public.profiles — the extra fields Supabase Auth doesn't store
--      (username, birth year). Email + password + email verification are
--      handled entirely by Supabase Auth (auth.users) — do not duplicate
--      email/password here.
--   2. A trigger that auto-creates a profiles row right after someone
--      finishes signup, using the metadata passed to supabase.auth.signUp().
--   3. Row Level Security so each user can only see/edit their own row.

create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text not null unique,
  birth_year integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Runs as the function owner (bypasses RLS), so it can insert on behalf of
-- a brand-new user whose session doesn't exist yet at insert time.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, birth_year)
  values (
    new.id,
    new.raw_user_meta_data ->> 'username',
    (new.raw_user_meta_data ->> 'birth_year')::integer
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();
