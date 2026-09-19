"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, UserCircle } from "@phosphor-icons/react";
import Aurora from "@/components/Aurora";
import ProfileEditor from "@/components/ProfileEditor";

const PROFILE_STORAGE_KEY = "aisle-profile-v1";

export default function ProfilePage() {
  const [loaded, setLoaded] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [context, setContext] = useState("");
  const [address, setAddress] = useState("");
  const [email, setEmail] = useState<string>();

  useEffect(() => {
    // Local first (instant), then the account if signed in.
    try {
      const saved = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || "null") as { tags?: string[]; context?: string; address?: string } | null;
      if (saved) { setTags(Array.isArray(saved.tags) ? saved.tags : []); setContext(typeof saved.context === "string" ? saved.context : ""); setAddress(typeof saved.address === "string" ? saved.address : ""); }
    } catch { /* ignore */ }
    fetch("/api/profile", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() as Promise<{ user?: { email?: string }; profile?: { profile_tags?: string[] | null; profile_context?: string | null; profile_address?: string | null } | null }> : null))
      .then((d) => {
        if (d?.user?.email) setEmail(d.user.email);
        if (d?.profile) { setTags(d.profile.profile_tags ?? []); setContext(d.profile.profile_context ?? ""); setAddress(d.profile.profile_address ?? ""); }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  return (
    <>
      <Aurora />
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, position: "relative", zIndex: 1 }}>
        <div className="card card-pad" style={{ width: "min(560px, 100%)", display: "flex", flexDirection: "column", gap: 18, boxShadow: "0 24px 80px rgba(0,0,0,.35)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <UserCircle size={28} weight="fill" color="var(--accent)" />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 660, fontSize: 18, letterSpacing: "-0.01em" }}>Your Aisle profile</div>
              <div style={{ color: "var(--muted)", fontSize: 12.5 }}>{email ? `Signed in as ${email}` : "Not signed in. Preferences save on this device."}</div>
            </div>
            <a className="btn btn-ghost btn-sm" href="/"><ArrowLeft size={15} /> Back to Aisle</a>
          </div>
          <div style={{ height: 1, background: "var(--border)" }} />
          {loaded
            ? <ProfileEditor initialTags={tags} initialContext={context} initialAddress={address} heading="Tell Aisle how to shop for you" />
            : <div style={{ color: "var(--muted)", fontSize: 14, padding: "20px 0" }}>Loading your preferences…</div>}
        </div>
      </div>
    </>
  );
}
