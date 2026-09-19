import { NextResponse } from "next/server";
import { matchStructured, fallbackAnswer } from "@/lib/agent";
import type { AgentRequest, ChatTurn } from "@/lib/types";

export const runtime = "nodejs";

const SYSTEM = [
  "You are Aisle, an agentic-checkout commerce agent, shown inside a demo web app.",
  "What you do: you discover what to buy, price it, get ONE human approval, then complete a real merchant checkout. Physical goods go through Agnic's Shopify checkout rail; software/SaaS and credits go through the vendor's own checkout.",
  "Vaulted card: the user stores a payment card once (with Agnic for physical goods, or the vendor for SaaS) so you can pay at checkout WITHOUT ever seeing or typing the number. You, the model, never handle card details.",
  "IMPORTANT: this is a DEMO deployment. No real payment happens, purchases are simulated, and there is no real vaulted card on file yet. Be upfront about that whenever the user asks whether something was really bought, charged, or which card was used.",
  "If the user wants to shop (buy or find a product, or a SaaS tool for a goal), tell them to name what they want and the app will show ranked options with pitches; you do not list products yourself in prose.",
  "Style: concise (2 to 4 sentences), concrete, friendly. Never use em dashes. Never invent order numbers, prices, or claim a real charge occurred.",
].join("\n");

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function llmAnswer(history: ChatTurn[], text: string): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_INFRA_KEY;
  if (!key) return null;
  const model = process.env.AISLE_CHAT_MODEL || "deepseek/deepseek-chat-v3.1";
  const messages = [
    { role: "system", content: SYSTEM },
    ...history.slice(-10).map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: text },
  ];
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://aisle.dev",
        "X-Title": "Aisle",
      },
      // No `models` fallback array: it can route to a model that returns null content.
      body: JSON.stringify({ model, max_tokens: 320, temperature: 0.4, messages }),
      signal: AbortSignal.timeout(22000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const c = data.choices?.[0]?.message?.content;
    // Enforce the no-em-dash house rule regardless of what the model returns.
    return typeof c === "string" && c.trim() ? c.trim().replace(/\s*[—–]\s*/g, ", ") : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  let body: AgentRequest;
  try {
    body = (await req.json()) as AgentRequest;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const state = body.state ?? { purchasedSkus: [], profileTags: [] };

  // A clear shopping intent or card action uses the reliable structured flow.
  const structured = matchStructured({ ...body, state });
  if (structured) {
    await delay(460 + Math.random() * 380);
    return NextResponse.json(structured);
  }

  // Anything else (a real question) is answered by the LLM; fall back if no key/model.
  const answer = await llmAnswer(body.history ?? [], body.text ?? "");
  return NextResponse.json(answer ? { blocks: [{ type: "text", text: answer }] } : fallbackAnswer(body.text ?? ""));
}
