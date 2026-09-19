// Quick manual test of the registration flow: node scripts/test-signup.js <email> <password>
// Triggers a real Supabase signup — check the inbox for the 6-digit code, then run test-verify.js.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const [, , email, password] = process.argv;
if (!email || !password) {
  console.error('Usage: node scripts/test-signup.js <email> <password>');
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

(async () => {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        username: `user_${Date.now()}`,
        birth_year: 2000,
      },
    },
  });

  if (error) {
    console.error('signUp failed:', error.message);
    process.exit(1);
  }

  console.log('signUp ok — user id:', data.user?.id);
  console.log(`Check ${email} for the 6-digit code, then run:`);
  console.log(`  node scripts/test-verify.js ${email} <code>`);
})();
