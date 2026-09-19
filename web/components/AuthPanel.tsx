"use client";

import { useState } from "react";
import { Lock, ShieldCheck, UserCircle } from "@phosphor-icons/react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export interface ProfileRecord {
  id?: string;
  username?: string | null;
  birth_year?: number | null;
  profile_context?: string | null;
  profile_tags?: string[] | null;
}

type Mode = "login" | "signup" | "verify";

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
        const { error: signupError } = await supabase.auth.signUp({ email: email.trim(), password, options: { data: { username: username.trim(), birth_year: Number(birthYear) } } });
        if (signupError) throw signupError;
        setNotice("Check your email for the verification code."); setMode("verify"); return;
      }
      if (mode === "verify") {
        const { error: verifyError } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "signup" });
        if (verifyError) throw verifyError;
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

  return <div style={{ position: "fixed", inset: 0, zIndex: 20, display: "grid", placeItems: "center", padding: 20, background: "rgba(4, 18, 14, .62)" }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="card card-pad" style={{ width: "min(420px, 100%)", display: "flex", flexDirection: "column", gap: 16, boxShadow: "0 24px 80px rgba(0,0,0,.35)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}><UserCircle size={24} weight="fill" color="var(--accent)" /><div><div style={{ fontWeight: 650 }}>{currentEmail ? "Your Aisle account" : mode === "signup" ? "Create your Aisle account" : mode === "verify" ? "Verify your email" : "Sign in to Aisle"}</div><div style={{ color: "var(--muted)", fontSize: 12.5 }}>{currentEmail ?? "Your password is handled by Supabase Auth."}</div></div></div>
      {mode === "signup" ? <><div className="field"><label className="label">Username</label><input className="input" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></div><div className="field"><label className="label">Birth year</label><input className="input" value={birthYear} onChange={(event) => setBirthYear(event.target.value)} inputMode="numeric" /></div></> : null}
      {mode !== "verify" ? <><div className="field"><label className="label">Email</label><input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></div><div className="field"><label className="label">Password</label><input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} /></div></> : <div className="field"><label className="label">6-digit verification code</label><input className="input" value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" maxLength={6} /></div>}
      {error ? <div style={{ color: "#ffb4a8", fontSize: 13 }}>{error}</div> : null}
      {notice ? <div style={{ color: "var(--accent)", fontSize: 13 }}>{notice}</div> : null}
      <button className="btn btn-primary" disabled={busy || (mode === "verify" ? code.length < 6 : !email || !password || (mode === "signup" && (!username || !birthYear)))} onClick={() => void submit()}><ShieldCheck size={16} weight="fill" />{busy ? "Working…" : mode === "signup" ? "Create account" : mode === "verify" ? "Verify email" : "Sign in"}</button>
      {currentEmail ? <button className="btn btn-ghost" onClick={() => void signOut()}><Lock size={15} /> Sign out</button> : mode === "verify" ? <button className="btn btn-ghost" onClick={() => setMode("signup")}>Back to signup</button> : <button className="btn btn-ghost" onClick={() => setMode(mode === "signup" ? "login" : "signup")}>{mode === "signup" ? "Already have an account? Sign in" : "Need an account? Sign up"}</button>}
      <div className="consent-note"><Lock size={14} /> Supabase Auth stores the password securely. Aisle stores only your profile preferences.</div>
    </div>
  </div>;
}
