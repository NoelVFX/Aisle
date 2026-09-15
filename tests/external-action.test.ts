import { describe, expect, it } from "vitest";
import { ExternalActionManager, extractPromptUrl, resolveExternalTarget, type ExternalActionExecutor } from "../src/web/external-action.js";
import { createGateway } from "../src/gateway/gateway.js";
import { FakeImageVendor, creditingPurchaser, imageVendorEntry, upstreamsWith } from "./helpers/image-vendor.js";
import type { SteelRunner } from "../src/gateway/recovery.js";

const steel: SteelRunner = {
  async run({ billingOrigin }) {
    return { sessionId: "s", debugUrl: undefined, viewerUrl: undefined, finalUrl: billingOrigin, title: undefined, screenshotPath: undefined };
  },
};

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

describe("prompt-driven external actions", () => {
  it("extracts a pasted link and strips sentence punctuation", () => {
    expect(extractPromptUrl("Generate it at https://shop.vendor.test/create, please")).toBe("https://shop.vendor.test/create");
  });

  it("synthesizes an ad-hoc vendor for an unconfigured origin (zero-integration)", () => {
    const target = resolveExternalTarget("Use https://any-saas.test/pricing", upstreamsWith(imageVendorEntry()));
    // The user-named origin becomes the LOCKED billing origin; no config entry needed.
    expect(target.provider).toBe("any-saas.test");
    expect(target.upstream.billingOrigin).toBe("https://any-saas.test");
    expect(target.upstream.canonicalOrigin).toBe("https://any-saas.test");
    expect(target.upstream.purchase?.mode).toBe("slow-lane");
    expect(target.upstream.offers).toEqual([]); // discovered at runtime
  });

  it("still rejects a non-https link", () => {
    expect(() => resolveExternalTarget("Use http://evil.test/create", upstreamsWith(imageVendorEntry()))).toThrow("HTTPS_REQUIRED");
  });

  it("replays the exact prompt after an approved billing recovery", async () => {
    const upstreams = upstreamsWith(imageVendorEntry({ purchase: true }));
    const vendor = new FakeImageVendor();
    const g = createGateway({
      upstreams,
      steel,
      purchaser: creditingPurchaser(vendor),
      env: {},
      safeBlockMs: 5,
      publicUrl: () => "http://127.0.0.1:8787",
      log: () => {},
    });
    const calls: string[] = [];
    const executor: ExternalActionExecutor = {
      async run(input) {
        calls.push(input.prompt);
        if (calls.length === 1) return { kind: "billing_wall", blocker: { type: "INSUFFICIENT_CREDITS", resource: "image_credits", required: 1, confidence: "high", raw: {} }, finalUrl: input.url };
        return { kind: "completed", note: "generated", finalUrl: input.url };
      },
    };
    const manager = new ExternalActionManager({ upstreams, coordinator: g.coordinator, executor, profilesDir: "/tmp/aisle-test-profiles" });
    const first = await manager.execute({ taskId: "t", prompt: "Generate a red bicycle at https://shop.vendor.test/create." });
    expect(first.status).toBe("AWAITING_APPROVAL");
    const recoveryId = String(first.status === "AWAITING_APPROVAL" ? first.recovery_id : "");
    const job = g.coordinator.get(recoveryId)!;
    await g.coordinator.approve(job.id, job.mandate!.signature);
    const done = json(await manager.wait(recoveryId));
    expect(done.status).toBe("COMPLETED");
    expect(calls).toEqual(["Generate a red bicycle at https://shop.vendor.test/create.", "Generate a red bicycle at https://shop.vendor.test/create."]);
  });
});
