/**
 * Real Steel connectivity smoke test — exercises SteelBrowserProvider end to end
 * WITHOUT any purchase: create session → connect Playwright over CDP → navigate
 * → screenshot → save profile → release.
 *
 *   node --env-file=.env --import tsx src/steel-smoke.ts
 *
 * Needs STEEL_API_KEY. A full runSlowLane against a real vendor additionally
 * needs a real VendorPurchaseAdapter for that site; this verifies the browser
 * plumbing on its own.
 */

import { writeFile } from "node:fs/promises";
import { SteelBrowserProvider } from "./slow-lane/steel-provider.js";

const TARGET = process.env["STEEL_SMOKE_URL"] ?? "https://example.com";

async function main(): Promise<void> {
  const provider = new SteelBrowserProvider({
    sessionOptions: { dimensions: { width: 1280, height: 800 } },
  });

  console.log("Creating Steel session…");
  const session = await provider.createSession({ provider: "steel-smoke" });
  console.log("  sessionId       :", session.sessionId);
  console.log("  live viewer     :", session.sessionViewerUrl);

  try {
    console.log(`Navigating to ${TARGET} …`);
    await session.page.goto(TARGET);
    console.log("  landed at       :", session.page.currentUrl());

    const heading = await session.page.textContent("h1");
    console.log("  <h1> text       :", heading?.trim() ?? "(none)");

    const png = await session.control.screenshot();
    await writeFile("steel-smoke.png", png);
    console.log("  screenshot      : steel-smoke.png", `(${png.byteLength} bytes)`);

    const profile = await session.saveProfile();
    const cookieCount = Array.isArray((profile.context as { cookies?: unknown[] }).cookies)
      ? (profile.context as { cookies: unknown[] }).cookies.length
      : 0;
    console.log("  saved profile   :", `${cookieCount} cookie(s) captured`);
  } finally {
    await session.close();
    console.log("Session released. ✓");
  }
}

main().catch((err) => {
  console.error("Steel smoke test failed:", err);
  process.exitCode = 1;
});
