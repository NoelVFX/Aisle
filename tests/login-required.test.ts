import { describe, it, expect } from "vitest";
import { ExternalActionManager, type ExternalActionExecutor } from "../src/web/external-action.js";
import type { Upstreams } from "../src/gateway/upstreams.js";

const ups: Upstreams = {
  higgsfield: {
    description: "", canonicalOrigin: "https://higgsfield.ai", billingOrigin: "https://higgsfield.ai",
    billingUrl: "https://higgsfield.ai/pricing", resource: "image_credits", offers: [],
  },
} as unknown as Upstreams;

function fakeExecutor(): { ran: boolean; executor: ExternalActionExecutor } {
  const state = { ran: false };
  return {
    get ran() { return state.ran; },
    executor: {
      async run() {
        state.ran = true;
        return { kind: "completed" as const, note: "done", finalUrl: "https://higgsfield.ai/" };
      },
    },
  };
}

const stubLogin = (loggedIn: boolean) => {
  const registered: string[] = [];
  return {
    registered,
    mgr: {
      isLoggedIn: async () => loggedIn,
      register: (p: string) => registered.push(p),
      start: async () => ({ provider: "x", active: true, loggedIn: false }),
      finish: async () => ({ provider: "x", active: false, loggedIn: true }),
      status: () => ({ provider: "x", active: false, loggedIn }),
    },
  };
};

describe("first-time link-based login", () => {
  it("returns LOGIN_REQUIRED with a link when the vendor has no saved profile", async () => {
    const ex = fakeExecutor();
    const login = stubLogin(false);
    const mgr = new ExternalActionManager({
      upstreams: ups,
      coordinator: {} as never,
      executor: ex.executor,
      profilesDir: "/tmp/none",
      loginManager: login.mgr as never,
      publicUrl: () => "http://127.0.0.1:8787",
    });
    const res = await mgr.execute({ taskId: "t1", prompt: "generate an image on higgsfield" });
    expect(res.status).toBe("LOGIN_REQUIRED");
    if (res.status === "LOGIN_REQUIRED") {
      expect(res.login_url).toBe("http://127.0.0.1:8787/login/higgsfield");
      expect(res.provider).toBe("higgsfield");
    }
    expect(ex.ran).toBe(false); // never launched the browser on a first-time vendor
    expect(login.registered).toContain("higgsfield");
  });

  it("proceeds normally once the vendor is signed in", async () => {
    const ex = fakeExecutor();
    const login = stubLogin(true);
    const mgr = new ExternalActionManager({
      upstreams: ups,
      coordinator: {} as never,
      executor: ex.executor,
      profilesDir: "/tmp/none",
      loginManager: login.mgr as never,
      publicUrl: () => "http://127.0.0.1:8787",
    });
    const res = await mgr.execute({ taskId: "t2", prompt: "generate an image on higgsfield" });
    expect(res.status).toBe("COMPLETED");
    expect(ex.ran).toBe(true);
  });
});
