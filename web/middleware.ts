import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Refreshes the Supabase auth session on each request and writes fresh cookies, so
 * server route handlers (e.g. /api/profile) always see a valid session. This is the
 * standard @supabase/ssr requirement; without it, server-side auth is flaky and
 * profile sync fails even when the client is signed in.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() { return request.cookies.getAll(); },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  try { await supabase.auth.getUser(); } catch { /* refresh best-effort */ }
  return response;
}

export const config = {
  // Run on pages and /api/profile, but skip static assets and the latency-sensitive chat route.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/chat|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
