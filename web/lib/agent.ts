import type { AgentRequest, AgentResponse, Block, Product } from "./types";
import { CATALOGUE, COMPLEMENTS, FOR_YOU, SAAS_PLANS, TOOL_RECS } from "./demoData";

/**
 * The demo agent. It mirrors the real Aisle tool flow (classify -> browse / find_tool /
 * shop -> approve -> receipt) with scripted, realistic data, so the web app deploys and
 * demos on its own. Set AISLE_GATEWAY_URL to route to a live Aisle gateway instead.
 */

const findProduct = (sku: string): Product | undefined =>
  [...Object.values(CATALOGUE).flat(), ...Object.values(COMPLEMENTS).flat(), ...FOR_YOU, ...SAAS_PLANS].find((p) => p.sku === sku);

const categoryOf = (text: string): keyof typeof CATALOGUE | undefined => {
  const t = text.toLowerCase();
  if (/blazer|jacket|suit/.test(t)) return "blazer";
  if (/keyboard|mechanical/.test(t)) return "keyboard";
  if (/desk|standing/.test(t)) return "desk";
  return undefined;
};

const complementCategoryOf = (sku: string): keyof typeof COMPLEMENTS | undefined => {
  if (sku.startsWith("kb-")) return "keyboard";
  if (sku.startsWith("blz-")) return "blazer";
  if (sku.startsWith("desk-")) return "desk";
  return undefined;
};

function rankForProfile(products: Product[], tags: string[]): Product[] {
  if (tags.length === 0) return products;
  return [...products].sort((a, b) => {
    const score = (p: Product) => p.attrs.filter((x) => tags.includes(x)).length + (tags.includes("budget-conscious") && p.attrs.includes("budget-friendly") ? 1 : 0);
    return score(b) - score(a);
  });
}

const saasTopic = (text: string): keyof typeof TOOL_RECS | undefined => {
  const t = text.toLowerCase();
  if (/email|send mail|newsletter/.test(t)) return "email";
  if (/payment|checkout|billing|stripe|charge/.test(t)) return "payments";
  if (/search|index|autocomplete/.test(t)) return "search";
  return undefined;
};

export function runAgent(req: AgentRequest): AgentResponse {
  const { action, text = "", state } = req;

  // --- Card actions -----------------------------------------------------------
  if (action?.kind === "pick" || action?.kind === "approve") {
    const product = findProduct(action.sku);
    if (!product) return { blocks: [{ type: "text", text: "That item is no longer available. Want me to pull up fresh options?" }] };

    if (action.kind === "approve") {
      const receiptBlock: Block = {
        type: "receipt",
        receipt: { orderId: "ord_" + Math.random().toString(36).slice(2, 9), item: product.title, amountMinor: product.priceMinor, currency: product.currency, status: "succeeded", merchantId: product.merchantId },
      };
      return {
        blocks: [
          { type: "text", text: `Done. I placed the order through ${product.merchantId.replace("m_", "")}'s checkout with your vaulted card, and confirmed the charge landed.` },
          receiptBlock,
          { type: "text", text: "That is where I stop. The receipt is yours. Want to keep shopping, or see your **For You** picks?" },
        ],
        purchasedSku: product.sku,
      };
    }

    // pick -> price it, ask for one approval. SaaS plans recur and have no complements.
    const isSaas = product.sku.startsWith("saas:");
    const compCat = complementCategoryOf(product.sku);
    const complements = isSaas || !compCat ? [] : COMPLEMENTS[compCat].slice(0, 3);
    return {
      blocks: [
        { type: "text", text: isSaas ? "Here is the plan and total before anything is charged. Nothing moves until you approve." : "Good pick. Here is the total before anything is charged. Nothing moves until you approve." },
        { type: "approval", product, totalMinor: product.priceMinor, currency: product.currency, ...(isSaas ? { recurring: "billed monthly" } : {}), complements },
      ],
    };
  }

  if (action?.kind === "saveProfile") {
    return {
      blocks: [
        { type: "profileSaved", tags: action.tags },
        { type: "text", text: "Saved, and kept on your device only. I never send it to a merchant. It just shapes what I put first. Ask me to show you something." },
      ],
      profileTags: action.tags,
    };
  }

  if (action?.kind === "forYou") {
    if (state.purchasedSkus.length === 0) return { blocks: [{ type: "forYouEmpty" }] };
    return {
      blocks: [
        { type: "text", text: "Built from what you have bought. This gets sharper every order." },
        { type: "shortlist", heading: "For You", products: FOR_YOU.filter((p) => !state.purchasedSkus.includes(p.sku)).slice(0, 3) },
      ],
    };
  }

  // --- Free text --------------------------------------------------------------
  const profileWanted = /profile|about me|personali[sz]e|remember me|set up|tell you about/i.test(text);
  if (profileWanted) {
    return { blocks: [{ type: "text", text: "Happy to tailor things. Tell me as much or as little as you like. It stays local." }, { type: "profileForm" }] };
  }

  const forYouWanted = /for you|recommend|surprise me|what should i/i.test(text);
  if (forYouWanted) return runAgent({ ...req, action: { kind: "forYou" }, text: "" });

  const topic = saasTopic(text);
  const looksSaas = /\btool\b|mcp|api|saas|subscription|plan|integrat/i.test(text);
  if (topic && looksSaas) {
    const rec = TOOL_RECS[topic];
    return {
      blocks: [
        { type: "text", text: `For that I would reach for **${rec.toolName}**. Here is the pick and why. When you want it, I buy the plan through their checkout with one approval.` },
        { type: "toolRec", rec },
      ],
    };
  }

  const cat = categoryOf(text);
  if (cat) {
    const ranked = rankForProfile(CATALOGUE[cat], state.profileTags);
    return {
      blocks: [
        { type: "text", text: `Here are five, ranked for you and each pitched a little differently. Pick one and I will price it. ${state.profileTags.length ? "Ordered around your profile." : ""}`.trim() },
        { type: "shortlist", heading: cap(cat), products: ranked },
      ],
    };
  }

  const buyish = /buy|shop|order|find me|show me|looking for|need a/i.test(text);
  if (buyish) {
    return { blocks: [{ type: "text", text: "Tell me what to shop for and I will pull a ranked shortlist. Try a **blazer**, a **keyboard**, or a **standing desk** for this demo, or ask me to find a **SaaS tool** for a goal." }] };
  }

  // Default / greeting
  return {
    blocks: [
      { type: "text", text: "I am Aisle. I discover, price, get your one approval, and buy through a real merchant's checkout. Physical goods route through Agnic's rail, software and credits through the vendor's own checkout. What are you after?" },
    ],
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
