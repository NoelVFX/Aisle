import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Handles Supabase confirmation links as well as token-hash links. */
export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = requestUrl.origin;
  const code = requestUrl.searchParams.get("code");
  const tokenHash = requestUrl.searchParams.get("token_hash");
  const type = requestUrl.searchParams.get("type") || "signup";

  try {
    const supabase = await createSupabaseServerClient();
    const result = code
      ? await supabase.auth.exchangeCodeForSession(code)
      : tokenHash
        ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as EmailOtpType })
        : { error: new Error("Missing Supabase confirmation code") };
    if (result.error) throw result.error;
    return NextResponse.redirect(new URL("/?auth=verified", origin));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email verification failed";
    return NextResponse.redirect(new URL(`/?auth_error=${encodeURIComponent(message)}`, origin));
  }
}
