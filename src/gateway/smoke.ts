/**
 * End-to-end smoke of the MCP gateway over real stdio, like Codex would run it.
 *   npm run smoke:gateway
 *
 * 1. openai__chat with whatever OPENAI_API_KEY is in .env (blank → 401 passes through).
 * 2. mockvendor__generate_image → 402 → AWAITING_APPROVAL → approve over HTTP →
 *    aisle__wait_for_recovery → real Steel session → mock credited → replayed image.
 *
 * Needs STEEL_API_KEY in .env for step 2 to open a real Steel session.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const firstText = (r: unknown): string => {
  const c = (r as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return c.find((x) => x.type === "text")?.text ?? "";
};
const tryJson = (s: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: join(ROOT, "node_modules/.bin/tsx"),
    args: [join(ROOT, "src/gateway/server.ts")],
    cwd: ROOT,
    env: {
      ...(process.env as Record<string, string>),
      SAFE_BLOCK_MS: "4000",
      AISLE_OPEN_APPROVAL: "0",
      AISLE_STEEL_HOLD_MS: "2000",
      AISLE_APPROVAL_PORT: "8797",
    },
    stderr: "inherit",
  });
  const client = new Client({ name: "aisle-smoke", version: "0.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log("tools:", tools.map((t) => t.name).join(", "));

  console.log("\n── 1. openai__chat ──");
  const chat = await client.callTool({ name: "openai__chat", arguments: { prompt: "Say hi in three words." } });
  console.log("isError:", chat.isError, "\n", firstText(chat).slice(0, 600));

  console.log("\n── 2. mockvendor__generate_image ──");
  let result = await client.callTool(
    { name: "mockvendor__generate_image", arguments: { prompt: "hero image #1" } },
    undefined,
    { onprogress: (p) => console.log("  progress:", p.message), timeout: 120_000 },
  );
  let body = tryJson(firstText(result));
  console.log("first result:", body?.["status"] ?? firstText(result).slice(0, 300));

  if (body?.["status"] === "AWAITING_APPROVAL") {
    const approveUrl = String(body["approve_url"]);
    const state = (await (await fetch(`${approveUrl}/state`)).json()) as { mandate?: { signature: string; cap: number }; quote?: { reason: string } };
    console.log("quote:", state.quote?.reason, "· cap $" + state.mandate?.cap);
    const res = await fetch(`${approveUrl}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mandate_signature: state.mandate?.signature }),
    });
    console.log("approve →", res.status);

    for (let i = 0; i < 20 && ["AWAITING_APPROVAL", "RECOVERY_RUNNING"].includes(String(body?.["status"])); i++) {
      result = await client.callTool(
        { name: "aisle__wait_for_recovery", arguments: { recovery_id: String(body!["recovery_id"]) } },
        undefined,
        { onprogress: (p) => console.log("  progress:", p.message), timeout: 120_000 },
      );
      body = tryJson(firstText(result)) ?? { status: "REPLAYED" };
    }
    console.log("final:", result.isError ? "ERROR" : "ok", "\n", firstText(result).slice(0, 800));
  }

  await client.close();
}

main().catch((err) => {
  console.error("gateway smoke failed:", err);
  process.exitCode = 1;
});
