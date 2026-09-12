import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenRouterPicker, parsePickerReply } from "../src/slow-lane/resolver/picker.js";
import { InfraBlockedError, ResolutionExhaustedError, type OpenRouterFetch } from "../src/index.js";
import type { ActionCandidate } from "../src/slow-lane/browser.js";

const candidates: ActionCandidate[] = [
  { index: 0, role: "link", name: "Account", near: "" },
  { index: 1, role: "button", name: "Buy 1,000 credits", near: "$5" },
  { index: 2, role: "button", name: "Buy 5,000 credits", near: "$20" },
];

function fetchReplies(replies: Array<{ status?: number; content: string }>, bodies: unknown[] = []): OpenRouterFetch {
  let i = 0;
  return async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const r = replies[Math.min(i++, replies.length - 1)]!;
    const status = r.status ?? 200;
    return { ok: status < 300, status, text: async () => JSON.stringify({ model: "nvidia/test", choices: [{ message: { content: r.content } }] }) };
  };
}

describe("parsePickerReply", () => {
  it("accepts an in-range index and rejects everything else", () => {
    expect(parsePickerReply('ok {"index": 2, "why": "5k pack"}', 3)).toEqual({ index: 2, why: "5k pack" });
    expect(() => parsePickerReply('{"index": 47}', 12)).toThrow(/OUT_OF_RANGE/);
    expect(() => parsePickerReply('{"index": "button.buy"}', 3)).toThrow(/OUT_OF_RANGE/);
    expect(() => parsePickerReply("click the blue one", 3)).toThrow(/BAD_REPLY/);
  });
});

describe("OpenRouter picker", () => {
  it("returns an index, never a selector, and sends only text", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const picker = createOpenRouterPicker({ apiKey: "infra", fetchImpl: fetchReplies([{ content: '{"index": 2, "why": "clears shortfall"}' }], bodies) });
    const r = await picker.pick({ goal: "buy 5,000 credits", candidates, stepKey: "k" });
    expect(r).toMatchObject({ index: 2, modelUsed: "nvidia/test", replayed: false });
    const prompt = JSON.stringify(bodies[0]);
    expect(prompt).toContain('[2] button \\"Buy 5,000 credits\\" near: $20');
    expect(prompt).not.toContain("image_url");
  });

  it("rejects an out-of-range reply in code and retries within budget", async () => {
    const picker = createOpenRouterPicker({ apiKey: "infra", budget: 5, fetchImpl: fetchReplies([{ content: '{"index": 47}' }, { content: '{"index": 1}' }]) });
    expect((await picker.pick({ goal: "g", candidates, stepKey: "k" })).index).toBe(1);
  });

  it("stops at the resolver budget with RESOLUTION_EXHAUSTED", async () => {
    const picker = createOpenRouterPicker({ apiKey: "infra", budget: 1, fetchImpl: fetchReplies([{ content: "nope" }]) });
    await expect(picker.pick({ goal: "g", candidates, stepKey: "k" })).rejects.toBeInstanceOf(ResolutionExhaustedError);
  });

  it("aborts a stalled model call and retries instead of hanging the purchase", async () => {
    let calls = 0;
    const stallThenAnswer: OpenRouterFetch = (_url, init) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      }
      return fetchReplies([{ content: '{"index": 2, "why": "5k"}' }])(_url, init);
    };
    const picker = createOpenRouterPicker({ apiKey: "infra", requestTimeoutMs: 20, fetchImpl: stallThenAnswer });
    expect((await picker.pick({ goal: "g", candidates, stepKey: "k" })).index).toBe(2);
    expect(calls).toBe(2);
  });

  it("fails loud when Aisle's own resolver key 402s", async () => {
    const picker = createOpenRouterPicker({ apiKey: "infra", fetchImpl: fetchReplies([{ status: 402, content: "" }]) });
    await expect(picker.pick({ goal: "g", candidates, stepKey: "k" })).rejects.toBeInstanceOf(InfraBlockedError);
  });

  it("REPLAY_RESOLVER replays recorded choices by role and name, with no model call", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "aisle-rec-")), "recordings.json");
    await createOpenRouterPicker({ apiKey: "infra", recordingsFile: file, fetchImpl: fetchReplies([{ content: '{"index": 2}' }]) }).pick({ goal: "g", candidates, stepKey: "shop|units:5000|0" });

    const shuffled = [candidates[2]!, candidates[0]!, candidates[1]!].map((c, index) => ({ ...c, index }));
    const noNetwork: OpenRouterFetch = async () => { throw new Error("no network in replay"); };
    const replayed = await createOpenRouterPicker({ replay: true, recordingsFile: file, fetchImpl: noNetwork }).pick({ goal: "g", candidates: shuffled, stepKey: "shop|units:5000|0" });
    expect(replayed).toMatchObject({ index: 0, replayed: true });
    expect(shuffled[replayed.index]?.name).toBe("Buy 5,000 credits");
  });
});
