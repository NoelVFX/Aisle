import { NextResponse } from "next/server";

export const runtime = "nodejs";

type OrderCtx = { item?: string; status?: string; eta?: string; address?: string; carrier?: string; tracking?: string; amount?: string };

/** Freeform Q&A about a single (demo) order. Deterministic actions (cancel / change
 *  address / change date) are handled on the page; this answers everything else. */
export async function POST(req: Request) {
  let body: { message?: string; order?: OrderCtx; history?: Array<{ role: "user" | "assistant"; content: string }> };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  const o = body.order ?? {};
  const fallback = "This is a demo order, so nothing really ships. You can ask how it is going, or say cancel, change address, or change date and I will update it here.";
  const key = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_INFRA_KEY;
  if (!key) return NextResponse.json({ reply: fallback });

  const model = process.env.AISLE_CHAT_MODEL || "deepseek/deepseek-chat-v3.1";
  const system = [
    "You are Aisle's order-tracking assistant on a DEMO order page. Be concise (1 to 3 sentences), concrete, friendly. Never use em dashes.",
    "This is a demo: no real shipment or charge. Be upfront about that if asked.",
    `Order: item="${o.item ?? ""}", status="${o.status ?? ""}", eta="${o.eta ?? ""}", delivery address="${o.address ?? ""}", carrier="${o.carrier ?? ""}", tracking="${o.tracking ?? ""}", amount="${o.amount ?? ""}".`,
    "Answer questions about this order. To actually cancel, change the delivery address, or change the delivery date, tell the user to say 'cancel', 'change address', or 'change date' and the page will do it. Do not invent tracking scans beyond the status.",
  ].join("\n");

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://aisle.dev", "X-Title": "Aisle" },
      body: JSON.stringify({ model, max_tokens: 220, temperature: 0.4, messages: [{ role: "system", content: system }, ...(Array.isArray(body.history) ? body.history.slice(-8) : []), { role: "user", content: String(body.message ?? "") }] }),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) return NextResponse.json({ reply: fallback });
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const c = data.choices?.[0]?.message?.content;
    const reply = typeof c === "string" && c.trim() ? c.trim().replace(/\s*[—–]\s*/g, ", ") : fallback;
    return NextResponse.json({ reply });
  } catch {
    return NextResponse.json({ reply: fallback });
  }
}
