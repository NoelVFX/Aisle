import { NextResponse } from "next/server";
import type { AgentRequest, AgentResponse, ChatTurn, Product, Signals } from "@/lib/types";
import { searchAgnic, searchComplements, agnicConfigured } from "@/lib/agnic";
import { pitchProducts, selectShortlist } from "@/lib/pitch";
import { normalizeSignals, learnedTags } from "@/lib/learning";
import { recommendTool, complementTools } from "@/lib/recommend";
import {
  approveResp, cleanQuery, fallbackAnswer, findToolResp, forYouWanted, isBrowse,
  isGreeting, isSaasIntent, isToolIntent, messageGender, personaQuery, profileFormResp, profileWanted, saasTopic, saveProfileResp,
} from "@/lib/agent";

export const runtime = "nodejs";
const COUNTRY = () => process.env.AGNIC_DEFAULT_COUNTRY || "US";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const noAgnic: AgentResponse = {
  blocks: [{ type: "text", text: "To show real products I pull them live from Shopify through Agnic, which needs an **AGNIC_TOKEN** on the server. Once that is set I will return real titles, prices and photos. Meanwhile I can still find a **SaaS tool** for a goal or answer questions." }],
};

const SYSTEM = [
  "You are Aisle, an agentic-checkout commerce agent, shown inside a demo web app.",
  "You discover what to buy, price it, get ONE human approval, then complete a real merchant checkout. Physical goods come from real Shopify shops via Agnic; software/SaaS and credits go through the vendor's own checkout.",
  "Vaulted card: the user stores a card once (with Agnic for physical goods, or the vendor for SaaS) so you can pay at checkout WITHOUT ever seeing or typing the number. You never handle card details.",
  "IMPORTANT: this is a DEMO deployment. No real payment happens, purchases are simulated, and there is no real vaulted card on file yet. Be upfront about that if asked whether something was really bought or charged.",
  "You never invent product details: real products come from Agnic's catalogue. If the user wants to shop, tell them to name what they want and the app shows real options; do not list products in prose.",
  "You CANNOT render product or tool cards yourself, the app does that. Never write '[searching]', '[shows options]', or claim that results are displayed. If the user asks for a tool or product, tell them to ask plainly (for example: 'find me an MCP tool for UI design') and the app will show real cards.",
  "Style: concise (2 to 4 sentences), concrete, friendly. Never use em dashes. Never invent order numbers, prices, or claim a real charge occurred.",
].join("\n");

async function llmAnswer(history: ChatTurn[], text: string): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_INFRA_KEY;
  if (!key) return null;
  const model = process.env.AISLE_CHAT_MODEL || "deepseek/deepseek-chat-v3.1";
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://aisle.dev", "X-Title": "Aisle" },
      body: JSON.stringify({
        model,
        max_tokens: 320,
        temperature: 0.4,
        messages: [{ role: "system", content: SYSTEM }, ...history.slice(-10).map((h) => ({ role: h.role, content: h.content })), { role: "user", content: text }],
      }),
      signal: AbortSignal.timeout(22000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const c = data.choices?.[0]?.message?.content;
    if (typeof c !== "string" || !c.trim()) return null;
    // The model sometimes fakes UI ("[showed options]"); strip those markers, never claim cards.
    const cleaned = c.trim().replace(/\s*[—–]\s*/g, ", ").replace(/\[(?:searching|search|show(?:s|ed|ing)?\s*options?|loading|results?|generating|thinking)\]/gi, "").replace(/\s{2,}/g, " ").trim();
    return cleaned || null;
  } catch {
    return null;
  }
}

async function browse(query: string, country: string, tags: string[], context: string, signals?: Signals): Promise<AgentResponse> {
  if (!agnicConfigured()) return noAgnic;
  const q = personaQuery(query, tags); // bias by saved persona (e.g. men's) before searching
  // Pull a wide pool so the shortlist can refresh each search instead of a fixed top 5.
  let products = await searchAgnic(q, country, 18);
  if (!products.length && q !== query) products = await searchAgnic(query, country, 18); // retry unbiased
  if (!products.length) return { blocks: [{ type: "text", text: `I could not find "${query}" in the Agnic network right now. Try different wording, or another item.` }] };
  const picks = selectShortlist(products, tags, 5, signals); // rank, then draw 5 with variety
  const pitched = await pitchProducts(picks, tags, context, signals);
  return {
    blocks: [
      { type: "text", text: `Here are ${pitched.length}, pulled from Shopify via Agnic and pitched for you. Pick one and I will price it.` },
      { type: "shortlist", heading: titleCase(query).slice(0, 40), products: pitched },
    ],
  };
}

async function pick(product: Product, country: string): Promise<AgentResponse> {
  const isSaas = product.sku.startsWith("saas:");
  // Complements at checkout for ANY item: SaaS -> paired tools (LLM); physical -> real Agnic results.
  const complements = isSaas ? await complementTools(product) : agnicConfigured() ? await searchComplements(product, country) : [];
  return {
    blocks: [
      { type: "text", text: isSaas ? "Here is the plan and total before anything is charged. Nothing moves until you approve." : "Good pick. Here is the total before anything is charged. Nothing moves until you approve." },
      { type: "approval", product, totalMinor: product.priceMinor, currency: product.currency, ...(isSaas ? { recurring: "billed monthly" } : {}), complements },
    ],
  };
}

async function findTool(text: string): Promise<AgentResponse> {
  const rec = await recommendTool(text);
  if (rec) {
    return {
      blocks: [
        { type: "text", text: `For that I would reach for **${rec.toolName}**. Here is the pick and why. When you want it, I buy the plan through their checkout with one approval.` },
        { type: "toolRec", rec },
      ],
    };
  }
  const topic = saasTopic(text);
  if (topic) return findToolResp(topic);
  return { blocks: [{ type: "text", text: "I could not pin down a solid tool for that just now. Try naming the job plainly, like \"send email\", \"add auth\", or \"hosted search\"." }] };
}

async function forYou(state: AgentRequest["state"], country: string): Promise<AgentResponse> {
  const titles = state.purchasedTitles ?? [];
  if (!titles.length) return { blocks: [{ type: "forYouEmpty" }] };
  if (!agnicConfigured()) return noAgnic;
  const signals = normalizeSignals(state.learned);
  const seen = new Set(state.purchasedSkus);
  const products: Product[] = [];
  // Candidates from recent purchases, plus a query built from the shopper's top-converting
  // attributes/colors so For You follows revealed preference, not just the last title bought.
  const queries = [...titles.slice(-2)];
  const lt = learnedTags(signals, 2);
  if (lt.length) queries.push(lt.join(" "));
  for (const query of queries) {
    for (const p of await searchAgnic(query, country, 4)) if (!seen.has(p.sku)) { seen.add(p.sku); products.push(p); }
  }
  if (!products.length) return { blocks: [{ type: "forYouEmpty" }] };
  // Draw 4 with variety, then pitch; the behavioral model still surfaces best-fit converters.
  const picks = selectShortlist(products, state.profileTags, 4, signals);
  const pitched = await pitchProducts(picks, state.profileTags, state.profileContext ?? "", signals);
  return {
    blocks: [
      { type: "text", text: "Built from what you have bought and how you shop, pulled fresh from Agnic." },
      { type: "shortlist", heading: "For You", products: pitched },
    ],
  };
}

export async function POST(req: Request) {
  let body: AgentRequest;
  try {
    body = (await req.json()) as AgentRequest;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const state = body.state ?? { purchasedSkus: [], profileTags: [] };
  const country = COUNTRY();
  const action = body.action;

  if (action?.kind === "pick") return NextResponse.json(await pick(action.product, country));
  if (action?.kind === "approve") { await delay(420); return NextResponse.json(approveResp(action.product)); }
  if (action?.kind === "saveProfile") { await delay(360); return NextResponse.json(saveProfileResp(action.tags, action.about)); }
  if (action?.kind === "forYou") return NextResponse.json(await forYou(state, country));

  const text = body.text ?? "";
  if (isToolIntent(text) || isSaasIntent(text)) return NextResponse.json(await findTool(text));
  if (profileWanted(text)) { await delay(320); return NextResponse.json(profileFormResp()); }
  if (forYouWanted(text)) return NextResponse.json(await forYou(state, country));
  if (isBrowse(text)) {
    const g = messageGender(text); // "I want male clothing" -> bias men's even without a saved profile
    const tags = g && !state.profileTags.includes(g) ? [...state.profileTags, g] : state.profileTags;
    return NextResponse.json(await browse(cleanQuery(text), country, tags, state.profileContext ?? "", normalizeSignals(state.learned)));
  }

  if (isGreeting(text)) { await delay(300); }
  const answer = await llmAnswer(body.history ?? [], text);
  return NextResponse.json(answer ? { blocks: [{ type: "text", text: answer }] } : fallbackAnswer(text));
}
