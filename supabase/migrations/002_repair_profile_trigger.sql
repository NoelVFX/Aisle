-- Repairs the original teammate schema/trigger so Supabase Auth signup cannot fail
-- because profile metadata is missing, malformed, or collides with a username.
-- Run after 001_profiles.sql in Supabase SQL Editor.

alter table if exists public.profiles add column if not exists profile_context text;
alter table if exists public.profiles add column if not exists profile_tags jsonb not null default '[]'::jsonb;
alter table if exists public.profiles alter column username drop not null;
alter table if exists public.profiles alter column birth_year drop not null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_username text;
  requested_birth_year integer;
begin
  requested_username := nullif(trim(new.raw_user_meta_data ->> 'username'), '');
  requested_birth_year := case
    when coalesce(new.raw_user_meta_data ->> 'birth_year', '') ~ '^[0-9]{4}$'
      then (new.raw_user_meta_data ->> 'birth_year')::integer
    else null
  end;

  begin
    insert into public.profiles (id, username, birth_year)
    values (new.id, coalesce(requested_username, 'user_' || left(new.id::text, 8)), requested_birth_year)
    on conflict (id) do nothing;
  exception when unique_violation then
    -- A duplicate username must not abort Supabase Auth signup.
    insert into public.profiles (id, birth_year)
    values (new.id, requested_birth_year)
    on conflict (id) do nothing;
  end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();
