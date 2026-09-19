import type { AgentResponse, Block, Product } from "./types";
import { TOOL_RECS } from "./demoData";

/**
 * Intent detection + the synchronous responses (profile, SaaS recommendation, approval
 * receipt, fallbacks). The async, network-backed responses (real Agnic browse, complements,
 * For You) live in the chat route.
 */

export const isQuestion = (t: string): boolean =>
  /[?]/.test(t) || /^\s*(what|why|how|who|when|where|which|is|are|do|does|did|can|could|should|will|would|tell me|explain)\b/i.test(t);

export const isGreeting = (t: string): boolean =>
  /^\s*(hi|hey|hello|yo|sup|thanks|thank you|thx|ok|okay|cool|nice|great|got it|gm|good morning)\b[\s!.]*$/i.test(t.trim());

/** Imperative shopping starts, matched only at the beginning so questions don't trip them. */
const IMPERATIVE = /^\s*(buy|shop|order|browse|find me|find|show me|show|get me|i want|i need|i'?m looking for|looking for|search for|purchase|need a|want a)\b/i;

export function saasTopic(t: string): keyof typeof TOOL_RECS | undefined {
  const s = t.toLowerCase();
  if (/email|send mail|newsletter/.test(s)) return "email";
  if (/payment|checkout|billing|stripe|charge card|subscription billing/.test(s)) return "payments";
  if (/search|index|autocomplete/.test(s)) return "search";
  return undefined;
}
const looksSaas = (t: string): boolean => /\btool\b|\bmcp\b|\bapi\b|saas|subscription|integrat|software|service/i.test(t);

export function isSaasIntent(t: string): boolean {
  return !!saasTopic(t) && looksSaas(t);
}

/** Broad "find me a tool/SaaS/MCP for <goal>" intent, for any goal (not just known topics). */
export function isToolIntent(t: string): boolean {
  const wantsTool = /\b(mcp|saas|api|tool|service|platform|software|library|integration|framework)\b/i.test(t);
  const seeking = /\b(find|recommend|suggest|need|want|looking|which|best|help me|get me|set up|add|build)\b/i.test(t) || /\bfor\b/i.test(t);
  return wantsTool && seeking;
}

export function profileWanted(t: string): boolean {
  const negated = /\b(skip|no|not|don'?t|without|later|nah|cancel|nevermind|never mind)\b/i.test(t);
  return !negated && (/\b(set ?up|create|edit|update|fill|do)\b.*\bprofile\b/i.test(t) || /\bprofile\b.*\b(set ?up|please)\b/i.test(t) || /about me|personali[sz]e|remember me|tell you about me|my preferences/i.test(t));
}

export const forYouWanted = (t: string): boolean => /for you|recommend|surprise me|what should i (buy|get)/i.test(t);

/** True for product-shopping phrasings. Questions and greetings are handled elsewhere. */
export function isBrowse(t: string): boolean {
  if (isSaasIntent(t) || isToolIntent(t)) return false;
  if (IMPERATIVE.test(t)) return true; // "find me a keyboard", "show me blazers"
  if (isQuestion(t) || isGreeting(t)) return false; // questions/greetings go to the LLM
  const words = t.trim().split(/\s+/).length;
  return words <= 7 && t.trim().length > 1; // short noun phrase, e.g. "keyboard"
}

/** Strip shopping verbs, articles and filler to a clean product query for Agnic. */
export function cleanQuery(t: string): string {
  return t
    .replace(/\b(please|for me|can you|could you|i(?:'m| am)?|would like to|want to|looking to)\b/gi, " ")
    .replace(/\b(buy|shop for|shop|order|find|show|browse|get me|get|need|want|purchase|search for|search|looking for|look for)\b/gi, " ")
    .replace(/^\s*(me|a|an|the|some|any)\b/gi, " ")
    .replace(/\b(a|an|the)\b/gi, " ")
    .replace(/[?.!,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim() || t.trim();
}

export function profileFormResp(): AgentResponse {
  return { blocks: [{ type: "text", text: "Happy to tailor things. Tell me as much or as little as you like. It stays on your device." }, { type: "profileForm" }] };
}

export function saveProfileResp(tags: string[]): AgentResponse {
  return {
    blocks: [
      { type: "profileSaved", tags },
      { type: "text", text: "Saved, and kept on your device only. I never send it to a merchant. It just shapes what I put first. Ask me to show you something." },
    ],
    profileTags: tags,
  };
}

export function findToolResp(topic: keyof typeof TOOL_RECS): AgentResponse {
  const rec = TOOL_RECS[topic];
  return {
    blocks: [
      { type: "text", text: `For that I would reach for **${rec.toolName}**. Here is the pick and why. When you want it, I buy the plan through their checkout with one approval.` },
      { type: "toolRec", rec },
    ],
  };
}

export function approveResp(product: Product): AgentResponse {
  const isSaas = product.sku.startsWith("saas:");
  const receipt: Block = {
    type: "receipt",
    receipt: { orderId: "ord_" + Math.random().toString(36).slice(2, 9), item: product.title, amountMinor: product.priceMinor, currency: product.currency, status: "succeeded", merchantId: product.merchantId || (isSaas ? "vendor" : "merchant"), demo: true },
  };
  return {
    blocks: [
      { type: "text", text: `Recorded your approval and ran the ${(product.merchantId || "merchant").replace("m_", "")} checkout flow. In this demo no card is charged, so this is a simulated receipt of what a real purchase returns.` },
      receipt,
      { type: "text", text: "In a live setup a real charge and evidence would land here, and I would stop. Want to keep shopping, or see your **For You** picks?" },
    ],
    purchasedSku: product.sku,
    purchasedTitle: product.title,
  };
}

export function fallbackAnswer(text = ""): AgentResponse {
  if (/vault|card|pay|charge|paid|money|charged/i.test(text)) {
    return { blocks: [{ type: "text", text: "Your **vaulted card** is a payment method you store once, so I can complete a checkout without ever seeing or typing the number. This is a demo build with no vaulted card on file, so nothing is really charged. Ask me to buy something to see the flow." }] };
  }
  return { blocks: [{ type: "text", text: "I am Aisle. Tell me what to buy and I pull real options, price them, and get your one approval before anything is charged. Physical goods come from Shopify via Agnic, software and credits through the vendor's own checkout." }] };
}
