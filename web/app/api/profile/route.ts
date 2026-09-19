import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return NextResponse.json({ user: null, profile: null }, { status: 401 });
    const { data: profile, error } = await supabase.from("profiles").select("id, username, birth_year, profile_context, profile_tags, created_at, updated_at").eq("id", user.id).maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ user: { id: user.id, email: user.email }, profile });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Supabase is not configured" }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await request.json() as { username?: unknown; birth_year?: unknown; profile_context?: unknown; profile_tags?: unknown };
    const context = typeof body.profile_context === "string" ? body.profile_context.trim().slice(0, 600) : "";
    const tags = Array.isArray(body.profile_tags) ? body.profile_tags.filter((tag): tag is string => typeof tag === "string").slice(0, 20) : [];
    const username = typeof body.username === "string" && body.username.trim() ? body.username.trim().slice(0, 80) : undefined;
    const birthYear = typeof body.birth_year === "number" && Number.isInteger(body.birth_year) && body.birth_year >= 1900 && body.birth_year <= new Date().getUTCFullYear() ? body.birth_year : undefined;
    const payload = { id: user.id, ...(username ? { username } : {}), ...(birthYear ? { birth_year: birthYear } : {}), profile_context: context || null, profile_tags: tags };
    const { data: profile, error } = await supabase.from("profiles").upsert(payload, { onConflict: "id" }).select("id, username, birth_year, profile_context, profile_tags, created_at, updated_at").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ profile });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: 400 });
  }
}
