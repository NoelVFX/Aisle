"use client";

import { useState } from "react";
import { Lock, ShieldCheck, UserCircle, ArrowSquareOut } from "@phosphor-icons/react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import ProfileEditor from "./ProfileEditor";

export interface ProfileRecord {
  id?: string;
  username?: string | null;
  birth_year?: number | null;
  profile_context?: string | null;
  profile_tags?: string[] | null;
}

type Mode = "login" | "signup" | "verify";

/** Accept a 6-digit OTP, a pasted confirmation link, or a bare token_hash from the email. */
function parseConfirmation(input: string): { kind: "otp"; token: string } | { kind: "code"; code: string } | { kind: "token_hash"; token_hash: string; type: string } | null {
  const v = input.trim();
  if (/^\d{4,8}$/.test(v)) return { kind: "otp", token: v };
  try {
    const u = new URL(v);
    const code = u.searchParams.get("code");
    const tokenHash = u.searchParams.get("token_hash");
    const type = u.searchParams.get("type") || "signup";
    if (code) return { kind: "code", code };
    if (tokenHash) return { kind: "token_hash", token_hash: tokenHash, type };
  } catch { /* not a URL */ }
  if (v.length > 12 && !/\s/.test(v)) return { kind: "token_hash", token_hash: v, type: "signup" };
  return null;
}

export default function AuthPanel({ email: currentEmail, profile, onProfile, onClose }: { email?: string; profile?: ProfileRecord | null; onProfile: (profile: ProfileRecord | null, email?: string) => void; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>(currentEmail ? "login" : "signup");
  const [email, setEmail] = useState(currentEmail ?? "");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState(profile?.username ?? "");
  const [birthYear, setBirthYear] = useState(profile?.birth_year ? String(profile.birth_year) : "");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const supabase = getSupabaseBrowserClient();
      if (mode === "signup") {
        const parsedBirthYear = Number(birthYear);
        if (!Number.isInteger(parsedBirthYear) || parsedBirthYear < 1900 || parsedBirthYear > new Date().getUTCFullYear()) throw new Error("Enter a valid birth year.");
        const { data: signupData, error: signupError } = await supabase.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: `${window.location.origin}/auth/confirm`, data: { username: username.trim(), birth_year: Number(birthYear) } } });
        if (signupError) {
          if (/database error saving new user/i.test(signupError.message)) throw new Error("Supabase profile setup is incomplete. Run supabase/migrations/001_profiles.sql and 002_repair_profile_trigger.sql, then try again.");
          throw signupError;
        }
        // If "Confirm email" is off in Supabase, signUp returns a session and the user is signed in now.
        if (signupData.session) { await loadProfile(); setNotice("Account created. You are signed in."); return; }
        setNotice("Check your email. Click the confirmation link, or paste the 6-digit code (or the whole link) below."); setMode("verify"); return;
      }
      if (mode === "verify") {
        const parsed = parseConfirmation(code);
        if (!parsed) throw new Error("Enter the 6-digit code from the email, or paste the confirmation link.");
        const result = parsed.kind === "otp"
          ? await supabase.auth.verifyOtp({ email: email.trim(), token: parsed.token, type: "signup" })
          : parsed.kind === "code"
            ? await supabase.auth.exchangeCodeForSession(parsed.code)
            : await supabase.auth.verifyOtp({ token_hash: parsed.token_hash, type: parsed.type as "signup" });
        if (result.error) throw result.error;
        await loadProfile(); setNotice("Email verified. You are signed in."); return;
      }
      const { error: loginError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (loginError) throw loginError;
      await loadProfile(); setNotice("Signed in.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed");
    } finally { setBusy(false); }
  };

  const loadProfile = async () => {
    const response = await fetch("/api/profile", { cache: "no-store" });
    if (!response.ok) throw new Error("Signed in, but the profile could not be loaded.");
    const data = await response.json() as { user?: { email?: string }; profile?: ProfileRecord | null };
    onProfile(data.profile ?? null, data.user?.email);
  };

  const signOut = async () => { await getSupabaseBrowserClient().auth.signOut(); onProfile(null); onClose(); };

  const signedIn = Boolean(currentEmail);

  return <div style={{ position: "fixed", inset: 0, zIndex: 20, display: "grid", placeItems: "center", padding: 20, background: "rgba(4, 18, 14, .62)", overflowY: "auto" }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="card card-pad" style={{ width: "min(440px, 100%)", display: "flex", flexDirection: "column", gap: 16, boxShadow: "0 24px 80px rgba(0,0,0,.35)", maxHeight: "90vh", overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}><UserCircle size={24} weight="fill" color="var(--accent)" /><div><div style={{ fontWeight: 650 }}>{signedIn ? "Your Aisle account" : mode === "signup" ? "Create your Aisle account" : mode === "verify" ? "Verify your email" : "Sign in to Aisle"}</div><div style={{ color: "var(--muted)", fontSize: 12.5 }}>{currentEmail ?? "Your password is handled by Supabase Auth."}</div></div></div>

      {signedIn ? <>
        <div style={{ color: "var(--muted)", fontSize: 13 }}>Set your preferences so Aisle ranks and pitches for you. You can also open the full <a className="product-link" href="/profile" target="_blank" rel="noreferrer">profile page <ArrowSquareOut size={12} weight="bold" /></a>.</div>
        <div style={{ height: 1, background: "var(--border)" }} />
        <ProfileEditor
          initialTags={profile?.profile_tags ?? []}
          initialContext={profile?.profile_context ?? ""}
          onSaved={(tags, context) => onProfile({ ...(profile ?? {}), profile_tags: tags, profile_context: context }, currentEmail)}
        />
        <button className="btn btn-ghost" onClick={() => void signOut()}><Lock size={15} /> Sign out</button>
      </> : <>
        {mode === "signup" ? <><div className="field"><label className="label">Username</label><input className="input" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></div><div className="field"><label className="label">Birth year</label><input className="input" value={birthYear} onChange={(event) => setBirthYear(event.target.value)} inputMode="numeric" /></div></> : null}
        {mode !== "verify" ? <><div className="field"><label className="label">Email</label><input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></div><div className="field"><label className="label">Password</label><input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} /></div></> : <div className="field"><label className="label">6-digit code, or paste the confirmation link</label><input className="input" value={code} onChange={(event) => setCode(event.target.value)} placeholder="123456 or https://…/auth/confirm?…" autoComplete="one-time-code" /></div>}
        {error ? <div style={{ color: "#ffb4a8", fontSize: 13 }}>{error}</div> : null}
        {notice ? <div style={{ color: "var(--accent)", fontSize: 13 }}>{notice}</div> : null}
        <button className="btn btn-primary" disabled={busy || (mode === "verify" ? code.trim().length < 4 : !email || !password || (mode === "signup" && (!username || !birthYear)))} onClick={() => void submit()}><ShieldCheck size={16} weight="fill" />{busy ? "Working…" : mode === "signup" ? "Create account" : mode === "verify" ? "Verify email" : "Sign in"}</button>
        {mode === "verify" ? <button className="btn btn-ghost" onClick={() => setMode("signup")}>Back to signup</button> : <button className="btn btn-ghost" onClick={() => setMode(mode === "signup" ? "login" : "signup")}>{mode === "signup" ? "Already have an account? Sign in" : "Need an account? Sign up"}</button>}
        <div className="consent-note"><Lock size={14} /> Supabase Auth stores the password securely. Aisle stores only your profile preferences.</div>
      </>}
    </div>
  </div>;
}
