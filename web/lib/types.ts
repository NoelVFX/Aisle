export type Tone = "value" | "aspirational" | "social_proof" | "expert" | "playful";

export interface Product {
  sku: string;
  title: string;
  priceMinor: number;
  currency: string;
  merchantId: string;
  image: string;
  tone: Tone;
  pitch: string;
  why?: string;
  attrs: string[];
}

export interface ToolRec {
  toolName: string;
  category: string;
  checkoutUrl: string;
  plan: string;
  why: string;
  alternatives: { toolName: string; why: string }[];
  hasMcp: boolean;
  /** For the buy button: a synthetic plan sku + price so the SaaS plan can flow to approval. */
  buySku: string;
  planPriceMinor: number;
  planCurrency: string;
}

export interface Receipt {
  orderId: string;
  item: string;
  amountMinor: number;
  currency: string;
  status: string;
  merchantId: string;
  /** Demo builds never charge a card; the receipt says so. */
  demo?: boolean;
}

/** A rendered unit inside an assistant turn. */
export type Block =
  | { type: "text"; text: string }
  | { type: "shortlist"; heading: string; products: Product[] }
  | { type: "forYouEmpty" }
  | { type: "profileForm" }
  | { type: "profileSaved"; tags: string[] }
  | { type: "approval"; product: Product; totalMinor: number; currency: string; recurring?: string; complements: Product[] }
  | { type: "receipt"; receipt: Receipt }
  | { type: "toolRec"; rec: ToolRec };

export interface Message {
  id: string;
  role: "user" | "aisle";
  blocks: Block[];
}

/** Prior turns as plain text, so the LLM branch has conversation context. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** What the composer / cards send to the agent. */
export interface AgentRequest {
  text?: string;
  history?: ChatTurn[];
  action?:
    | { kind: "pick"; product: Product }
    | { kind: "approve"; product: Product }
    | { kind: "browse"; query?: string }
    | { kind: "saveProfile"; about: string; tags: string[]; budget?: string }
    | { kind: "forYou"; purchasedTitles?: string[] };
  state: { purchasedSkus: string[]; purchasedTitles?: string[]; profileTags: string[] };
}

export interface AgentResponse {
  blocks: Block[];
  /** Client state updates. */
  purchasedSku?: string;
  purchasedTitle?: string;
  profileTags?: string[];
}
