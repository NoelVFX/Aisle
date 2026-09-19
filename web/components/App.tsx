"use client";

import { useEffect, useState } from "react";
import Aurora from "./Aurora";
import Landing from "./Landing";
import Rail from "./Rail";
import Chat from "./Chat";
import AuthPanel, { type ProfileRecord } from "./AuthPanel";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

const PROFILE_STORAGE_KEY = "aisle-profile-v1";

export default function App() {
  const [started, setStarted] = useState(false);
  const [initialPrompt, setInitialPrompt] = useState<string | undefined>();
  const [accountOpen, setAccountOpen] = useState(false);
  const [email, setEmail] = useState<string>();
  const [profile, setProfile] = useState<ProfileRecord | null>(null);

  useEffect(() => {
    let alive = true;
    try {
      const supabase = getSupabaseBrowserClient();
      void supabase.auth.getSession().then(async ({ data }) => {
        if (!alive || !data.session?.user) return;
        setEmail(data.session.user.email);
        const response = await fetch("/api/profile", { cache: "no-store" });
        if (response.ok) {
          const payload = await response.json() as { profile?: ProfileRecord | null };
          if (alive) applyProfile(payload.profile ?? null);
        }
      }).catch(() => {});
      const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
        if (!session?.user) {
          setEmail(undefined); setProfile(null);
          if (event === "SIGNED_OUT") { setStarted(false); setInitialPrompt(undefined); setAccountOpen(false); } // back to home
          return;
        }
        setEmail(session.user.email);
        void fetch("/api/profile", { cache: "no-store" })
          .then((response) => response.ok ? response.json() as Promise<{ profile?: ProfileRecord | null }> : null)
          .then((payload) => { if (alive && payload) applyProfile(payload.profile ?? null); });
      });
      return () => { alive = false; listener.subscription.unsubscribe(); };
    } catch { return () => { alive = false; }; }
  }, []);

  const applyProfile = (next: ProfileRecord | null) => {
    setProfile(next);
    if (next) localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({ tags: next.profile_tags ?? [], context: next.profile_context ?? "" }));
  };

  return <>
    <Aurora />
    <button className="btn btn-ghost btn-sm" style={{ position: "fixed", top: 16, right: 16, zIndex: 10 }} onClick={() => setAccountOpen(true)}>{email ? email : "Sign in"}</button>
    {!started ? <Landing name={profile?.username?.trim() || (email ? email.split("@")[0] : "user")} onStart={(p) => { setInitialPrompt(p); setStarted(true); }} /> : <div className="shell"><Rail /><main className="main"><Chat initialPrompt={initialPrompt} profileSeed={profile} /></main></div>}
    {accountOpen ? <AuthPanel email={email} profile={profile} onProfile={(next, nextEmail) => { applyProfile(next); if (nextEmail) setEmail(nextEmail); }} onClose={() => setAccountOpen(false)} /> : null}
  </>;
}
