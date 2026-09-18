import { NextResponse } from "next/server";
import { runAgent } from "@/lib/agent";
import type { AgentRequest } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Chat endpoint. In demo mode (default) it runs the scripted Aisle agent in-process.
 * If AISLE_GATEWAY_URL is set, this is where you'd forward to a running Aisle gateway
 * (its MCP tools: aisle__browse / aisle__set_profile / aisle__shop / aisle__wait_for_purchase).
 */
export async function POST(req: Request) {
  let body: AgentRequest;
  try {
    body = (await req.json()) as AgentRequest;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const state = body.state ?? { purchasedSkus: [], profileTags: [] };

  // Small, believable latency so the typing indicator reads as real work.
  await new Promise((r) => setTimeout(r, 480 + Math.random() * 420));

  const result = runAgent({ ...body, state });
  return NextResponse.json(result);
}
