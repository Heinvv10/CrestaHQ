import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every Vapi webhook route authenticates the caller by the `?s=` secret. The
 * compare must be constant-time: a `===` on a caller-controlled string leaks
 * how many leading characters matched. Asserted through the REAL routes (not
 * a helper beside them) by watching node:crypto's timingSafeEqual.
 */

const timingSafeEqual = vi.hoisted(() => vi.fn());
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  timingSafeEqual.mockImplementation(real.timingSafeEqual);
  return { ...real, default: { ...real, timingSafeEqual }, timingSafeEqual };
});
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));

const SECRET = "vapi-secret-fixture";
const ORIGINAL = process.env.VAPI_WEBHOOK_SECRET;
beforeEach(() => {
  process.env.VAPI_WEBHOOK_SECRET = SECRET;
  timingSafeEqual.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.VAPI_WEBHOOK_SECRET;
  else process.env.VAPI_WEBHOOK_SECRET = ORIGINAL;
});

const routes = {
  status: () => import("@/app/api/webhooks/vapi/status/[subAccountId]/route"),
  "end-of-call": () => import("@/app/api/webhooks/vapi/end-of-call/[subAccountId]/route"),
  llm: () => import("@/app/api/webhooks/vapi/llm/[subAccountId]/route"),
};

function call(POST: (r: Request, c: { params: Promise<{ subAccountId: string }> }) => Promise<Response>, s: string | null) {
  const q = s === null ? "" : `?s=${encodeURIComponent(s)}`;
  // Not JSON: an authorized request stops at the body parse (400), before
  // any Firestore or model call.
  return POST(new Request(`https://app.test/api/webhooks/vapi/x/sa1${q}`, { method: "POST", body: "not json" }), {
    params: Promise.resolve({ subAccountId: "sa1" }),
  });
}

describe.each(Object.entries(routes))("Vapi %s webhook auth", (_name, load) => {
  // The first import of a route module is a cold compile of its whole import
  // graph. Paying it inside the first test made that test time out at 5s on a
  // loaded box (the deploy gate failed on it three times running); paying it
  // here, with room to spare, leaves each test timing only its own work.
  beforeAll(async () => {
    await load();
  }, 60_000);

  it("accepts the right secret via a constant-time compare", async () => {
    const { POST } = await load();
    const res = await call(POST, SECRET);
    expect(res.status).toBe(400);
    expect(timingSafeEqual).toHaveBeenCalled();
  });

  it("refuses a wrong, shorter, longer or missing secret", async () => {
    const { POST } = await load();
    for (const s of ["vapi-secret-fixturX", "vapi", `${SECRET}x`, "", null]) {
      expect((await call(POST, s)).status).toBe(401);
    }
  });

  it("refuses everything when the server has no secret configured", async () => {
    delete process.env.VAPI_WEBHOOK_SECRET;
    const { POST } = await load();
    expect((await call(POST, SECRET)).status).toBe(401);
  });
});
