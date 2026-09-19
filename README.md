# order-integration — database setup

Auth (email + password + the 6-digit signup verification code) is handled by
**Supabase Auth**. This repo only adds `public.profiles` for the extra fields
(username, birth year) — see `prisma/schema.prisma` and `supabase/schema.sql`.

## 1. Create the Supabase project

Go to [supabase.com](https://supabase.com), sign up / log in, and create a new
project (pick a region, set a database password — save it, you'll need it
below).

## 2. Fill in `.env`

Copy `.env.example` to `.env` and fill in:

- `DATABASE_URL` / `DIRECT_URL` — Settings → Database → Connection string
  (use the "Transaction" pooler string for `DATABASE_URL`, the direct one for
  `DIRECT_URL`).
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` — Settings → API.

## 3. Switch signup verification to a 6-digit code

By default Supabase's "Confirm signup" email sends a clickable link, not a
code. To send a 6-digit code instead:

1. Authentication → Email Templates → **Confirm signup**.
2. Replace the link markup with the token variable, e.g.:
   ```
   Your verification code is: {{ .Token }}
   ```
3. Authentication → Providers → Email → make sure **Confirm email** is
   enabled.

The app will then call `supabase.auth.signUp()` to register, and
`supabase.auth.verifyOtp({ email, token, type: 'signup' })` with the 6-digit
code the user received to complete verification.

## 4. Create the `profiles` table

Supabase dashboard → SQL Editor → New query → paste the contents of
`supabase/schema.sql` → Run. This creates the table, the auto-profile-creation
trigger, and its RLS policies.

## 5. Generate the Prisma client

```bash
npm install
npm run db:generate
```

## Notes

- Never insert into `profiles` directly — a row is created automatically
  right after signup by the `on_auth_user_created` trigger, populated from
  the `username` / `birth_year` you pass as `options.data` to
  `supabase.auth.signUp()`.
- Add more columns to `public.profiles` (and the matching `Profile` model in
  `prisma/schema.prisma`) as new fields come up — RLS already restricts each
  row to its own user.
