"use client";

import { useMemo, useState } from "react";
import { ShieldCheck, Lock } from "@phosphor-icons/react";

const PROFILE_STORAGE_KEY = "aisle-profile-v1";

const GENDER = ["man", "woman"];
const BUDGET = ["budget-conscious", "mid-range", "premium-seeker"];
const OCCUPATION = ["student", "professional"];
const STYLE = ["smart-casual", "casual", "formal", "minimalist", "sporty", "tech", "eco-conscious"];

/** Save + edit shopping preferences. Used for onboarding (after signup) and the /profile page. */
export default function ProfileEditor({
  initialTags = [],
  initialContext = "",
  onSaved,
  heading = "Your shopping preferences",
}: {
  initialTags?: string[];
  initialContext?: string;
  onSaved?: (tags: string[], context: string) => void;
  heading?: string;
}) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [about, setAbout] = useState(initialContext);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");

  const groups = useMemo(() => [
    { label: "You are", options: GENDER },
    { label: "Budget", options: BUDGET },
    { label: "Life", options: OCCUPATION },
    { label: "Style and interests", options: STYLE },
  ], []);

  const groupOf = (opt: string): string[] | null =>
    GENDER.includes(opt) ? GENDER : BUDGET.includes(opt) ? BUDGET : OCCUPATION.includes(opt) ? OCCUPATION : null;

  const toggle = (opt: string) => {
    setTags((cur) => {
      if (cur.includes(opt)) return cur.filter((x) => x !== opt);
      const grp = groupOf(opt); // single-select within its group; null = multi-select (style)
      const base = grp ? cur.filter((x) => !grp.includes(x)) : cur;
      return [...base, opt];
    });
  };

  const save = async () => {
    setStatus("saving"); setMessage("");
    const context = about.trim();
    try { localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({ tags, context })); } catch { /* ignore */ }
    try {
      const res = await fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile_context: context, profile_tags: tags }) });
      if (res.status === 401) { setStatus("saved"); setMessage("Saved on this device. Sign in to sync it across devices."); }
      else if (!res.ok) {
        let detail = "";
        try { const j = await res.json() as { error?: unknown }; detail = typeof j.error === "string" ? j.error : ""; } catch { /* ignore */ }
        setStatus("error");
        setMessage(detail ? `Could not sync: ${detail} (saved on this device)` : "Could not sync to your account, but it is saved on this device.");
      }
      else { setStatus("saved"); setMessage("Preferences saved to your account."); }
    } catch {
      setStatus("saved"); setMessage("Saved on this device.");
    }
    onSaved?.(tags, context);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ fontWeight: 640, fontSize: 15 }}>{heading}</div>
      {groups.map((g) => (
        <div className="field" key={g.label}>
          <span className="label">{g.label}</span>
          <div className="chips">
            {g.options.map((opt) => (
              <button key={opt} className="chip" aria-pressed={tags.includes(opt)} onClick={() => toggle(opt)}>{opt}</button>
            ))}
          </div>
        </div>
      ))}
      <div className="field">
        <label className="label" htmlFor="about">Anything else (optional)</label>
        <textarea id="about" className="textarea" placeholder="e.g. 19 y/o male university student, into mechanical keyboards, tight budget" value={about} onChange={(e) => setAbout(e.target.value)} />
      </div>
      <div className="consent-note"><Lock size={14} /> Stored on your device and, when signed in, synced to your private Aisle profile. Never sent to a merchant.</div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={status === "saving"}>
          <ShieldCheck size={16} weight="fill" /> {status === "saving" ? "Saving…" : "Save preferences"}
        </button>
        {message ? <span style={{ fontSize: 12.5, color: status === "error" ? "#ffb4a8" : "var(--accent)" }}>{message}</span> : null}
      </div>
    </div>
  );
}
