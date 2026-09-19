// Quick manual test of the 6-digit verification step: node scripts/test-verify.js <email> <code>
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const [, , email, token] = process.argv;
if (!email || !token) {
  console.error('Usage: node scripts/test-verify.js <email> <6-digit-code>');
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

(async () => {
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: 'signup',
  });

  if (error) {
    console.error('verifyOtp failed:', error.message);
    process.exit(1);
  }

  console.log('verified — user id:', data.user?.id);
  console.log('Check Supabase Table Editor → profiles for the auto-created row.');
})();
