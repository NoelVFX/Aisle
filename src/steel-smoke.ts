/**
 * Real Steel connectivity smoke test — exercises SteelBrowserProvider end to end
 * WITHOUT any purchase, including the Profiles API round trip (steel.md §22):
 *
 *   run 1: create on a new profile → CDP → navigate → screenshot → release
 *          → poll the profile to READY (timed)
 *   run 2: restore the same profile (read-only) → navigate → release
 *
 *   node --env-file=.env --import tsx src/steel-smoke.ts
 *
 * Needs STEEL_API_KEY. Set STEEL_DEDICATED_IP_ID to also exercise the IP pin.
 * A full runSlowLane against a real vendor additionally needs a real
 * VendorPurchaseAdapter for that site; this verifies the browser plumbing on
 * its own.
 */

import { writeFile } from "node:fs/promises";
import { SteelBrowserProvider } from "./slow-lane/steel-provider.js";

const TARGET = process.env["STEEL_SMOKE_URL"] ?? "https://example.com";
const PROVIDER = "steel-smoke";

/** profileIds are credential-tier (steel.md §6); print just enough to eyeball. */
const mask = (id: string): string => `${id.slice(0, 4)}…${id.slice(-4)}`;

async function main(): Promise<void> {
  const provider = new SteelBrowserProvider({
    sessionOptions: { dimensions: { width: 1280, height: 800 } },
  });

  console.log("Run 1: creating a Steel session on a new profile…");
  const first = await provider.createSession({ provider: PROVIDER });
  const profile = first.profile;
  console.log("  sessionId       :", first.sessionId);
  console.log("  live viewer     :", first.sessionViewerUrl);

  try {
    console.log("  profile         :", profile ? mask(profile.profileId) : "(none)");
    console.log("  dedicated IP    :", profile?.dedicatedIpId ?? "(not pinned)");

    console.log(`Navigating to ${TARGET} …`);
    await first.page.goto(TARGET);
    console.log("  landed at       :", first.page.currentUrl());

    const heading = await first.page.textContent("h1");
    console.log("  <h1> text       :", heading?.trim() ?? "(none)");

    const png = await first.control.screenshot();
    await writeFile("steel-smoke.png", png);
    console.log("  screenshot      : steel-smoke.png", `(${png.byteLength} bytes)`);
  } finally {
    await first.close();
    console.log("  released        : profile write started");
  }
  if (!profile) throw new Error("Steel mounted no profile on a persistProfile session.");

  console.log("Waiting for the profile to persist…");
  const started = Date.now();
  const status = await provider.waitForProfileReady(profile.profileId);
  console.log("  status          :", status, `after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (status !== "READY") throw new Error(`Profile did not reach READY (${status}).`);

  console.log("Run 2: restoring the same profile (read-only)…");
  const second = await provider.createSession({
    provider: PROVIDER,
    profile: { userId: "steel-smoke", provider: PROVIDER, ...profile },
    persistProfile: false,
  });
  try {
    console.log("  profile mounted :", second.profile?.profileId === profile.profileId ? "same profile" : "MISMATCH");
    await second.page.goto(TARGET);
    console.log("  landed at       :", second.page.currentUrl());
  } finally {
    await second.close();
    console.log("Session released. ✓");
  }
}

main().catch((err) => {
  console.error("Steel smoke test failed:", err);
  process.exitCode = 1;
});
