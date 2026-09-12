import { describe, it, expect } from "vitest";
import {
  assertProfileMounted,
  buildSessionCreateParams,
  waitForProfileReady,
  type SteelProfilesClient,
  type SteelProviderOptions,
} from "../src/index.js";

const NO_ENV = {};
const PROVIDER = "vendor";
const BINDING = { userId: "u1", provider: PROVIDER, profileId: "prof_1" };

describe("buildSessionCreateParams — Profiles API (steel.md §6)", () => {
  it("asks Steel to create and persist a profile when none is bound", () => {
    const { params } = buildSessionCreateParams({}, { provider: PROVIDER }, NO_ENV);
    expect(params.persistProfile).toBe(true);
    expect(params.profileId).toBeUndefined();
    expect(params.sessionContext).toBeUndefined();
  });

  it("restores the bound profile", () => {
    const { params } = buildSessionCreateParams({}, { provider: PROVIDER, profile: BINDING }, NO_ENV);
    expect(params.profileId).toBe("prof_1");
    expect(params.persistProfile).toBe(true);
  });

  it("mounts without persisting for read-only sessions", () => {
    const { params } = buildSessionCreateParams({}, { provider: PROVIDER, profile: BINDING, persistProfile: false }, NO_ENV);
    expect(params.profileId).toBe("prof_1");
    expect(params.persistProfile).toBe(false);
  });

  it("refuses profile selection through the sessionOptions escape hatch", () => {
    const sneaky: Array<SteelProviderOptions["sessionOptions"]> = [
      { profileId: "prof_other" },
      { persistProfile: false },
      { sessionContext: {} } as SteelProviderOptions["sessionOptions"],
    ];
    for (const sessionOptions of sneaky) {
      expect(() => buildSessionCreateParams({ sessionOptions }, { provider: PROVIDER }, NO_ENV)).toThrow(/sessionOptions/);
    }
  });
});

describe("buildSessionCreateParams — dedicated IP pin (steel.md §6, §9)", () => {
  it("uses the residential pool when nothing is pinned", () => {
    const plan = buildSessionCreateParams({}, { provider: PROVIDER }, NO_ENV);
    expect(plan.params.useProxy).toBe(true);
    expect(plan.dedicatedIpId).toBeUndefined();
  });

  it("pins a new profile to STEEL_DEDICATED_IP_ID", () => {
    const plan = buildSessionCreateParams({}, { provider: PROVIDER }, { STEEL_DEDICATED_IP_ID: "fixed:env" });
    expect(plan.params.useProxy).toEqual({ type: "fixed", id: "fixed:env" });
    expect(plan.dedicatedIpId).toBe("fixed:env");
  });

  it("keeps a restored profile on its own IP, whatever is configured", () => {
    const plan = buildSessionCreateParams(
      { dedicatedIpId: "fixed:new", useProxy: true },
      { provider: PROVIDER, profile: { ...BINDING, dedicatedIpId: "fixed:old" } },
      { STEEL_DEDICATED_IP_ID: "fixed:env" },
    );
    expect(plan.params.useProxy).toEqual({ type: "fixed", id: "fixed:old" });
    expect(plan.dedicatedIpId).toBe("fixed:old");
  });

  it("refuses a proxyUrl that would move a pinned profile to a new egress", () => {
    const pinned = { provider: PROVIDER, profile: { ...BINDING, dedicatedIpId: "fixed:old" } };
    expect(() => buildSessionCreateParams({ proxyUrl: "http://u:p@proxy:8080" }, pinned, NO_ENV)).toThrow(/PROFILE_IP_PIN_CONFLICT/);
    expect(() => buildSessionCreateParams({ sessionOptions: { proxyUrl: "http://u:p@proxy:8080" } }, pinned, NO_ENV)).toThrow(
      /PROFILE_IP_PIN_CONFLICT/,
    );
  });

  it("still passes a proxyUrl through when nothing is pinned", () => {
    const { params } = buildSessionCreateParams({ proxyUrl: "http://u:p@proxy:8080" }, { provider: PROVIDER }, NO_ENV);
    expect(params.proxyUrl).toBe("http://u:p@proxy:8080");
  });
});

describe("assertProfileMounted", () => {
  it("returns the id Steel created for a persistProfile session", () => {
    expect(assertProfileMounted({ profileId: "prof_new" }, { persistProfile: true })).toBe("prof_new");
  });

  it("throws when persistProfile created nothing", () => {
    expect(() => assertProfileMounted({}, { persistProfile: true })).toThrow(/STEEL_PROFILE_NOT_CREATED/);
  });

  it("throws, without echoing the id, when the requested profile was not mounted", () => {
    const err = (() => {
      try {
        assertProfileMounted({ profileId: "prof_2" }, { profileId: "prof_1", persistProfile: true });
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(err?.message).toMatch(/STEEL_PROFILE_NOT_MOUNTED/);
    expect(err?.message).not.toMatch(/prof_/);
  });
});

describe("waitForProfileReady", () => {
  function fake(statuses: Array<"UPLOADING" | "READY" | "FAILED">) {
    let calls = 0;
    let t = 0;
    const client: SteelProfilesClient = {
      profiles: { get: async () => ({ status: statuses[Math.min(calls++, statuses.length - 1)]! }) },
    };
    const clock = { now: () => t, sleep: async (ms: number) => void (t += ms), pollMs: 1_000 };
    return { client, clock, calls: () => calls };
  }

  it("polls through UPLOADING until READY", async () => {
    const { client, clock, calls } = fake(["UPLOADING", "UPLOADING", "READY"]);
    expect(await waitForProfileReady(client, "prof_1", clock)).toBe("READY");
    expect(calls()).toBe(3);
  });

  it("reports FAILED", async () => {
    const { client, clock } = fake(["UPLOADING", "FAILED"]);
    expect(await waitForProfileReady(client, "prof_1", clock)).toBe("FAILED");
  });

  it("gives up with TIMEOUT", async () => {
    const { client, clock } = fake(["UPLOADING"]);
    expect(await waitForProfileReady(client, "prof_1", { ...clock, timeoutMs: 3_000 })).toBe("TIMEOUT");
  });
});
