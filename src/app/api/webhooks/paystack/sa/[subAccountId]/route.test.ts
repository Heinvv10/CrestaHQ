import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The per-sub-account Paystack webhook is a PUBLIC path: the HMAC signature is
 * the only credential, and the sub-account id in the URL is untrusted routing
 * information. These tests exist to make a weakened signature check fail loudly
 * — a route that accepts unverified bodies lets whoever guesses the URL write
 * to a tenant's connection state.
 */

const SUB = "sa_1";
// Tiny fixtures, matching this repo's existing Stripe test convention, so the
// blocking gitleaks gate does not read test data as a real Stripe key.
const KEY = "sk_test_k1";
const OTHER_KEY = "sk_test_k2";
const BODY = '{"event":"charge.success","data":{"reference":"ref_1"}}';

const sign = (body: string, key = KEY) =>
  createHmac("sha512", key).update(body).digest("hex");

let secretDoc: Record<string, unknown> | undefined;
let updates: Array<{ path: string; data: Record<string, unknown> }>;

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => ({
        exists: secretDoc !== undefined,
        data: () => secretDoc,
      }),
      update: async (data: Record<string, unknown>) => {
        updates.push({ path, data });
      },
    }),
  }),
}));

import { POST } from "./route";

function call(opts: { body?: string; signature?: string | null } = {}) {
  const body = opts.body ?? BODY;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature =
    opts.signature === undefined ? sign(body) : opts.signature;
  if (signature !== null) headers["x-paystack-signature"] = signature;
  return POST(
    new Request(`http://app.local/api/webhooks/paystack/sa/${SUB}`, {
      method: "POST",
      headers,
      body,
    }),
    { params: Promise.resolve({ subAccountId: SUB }) },
  );
}

beforeEach(() => {
  updates = [];
  secretDoc = { secretKey: KEY };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signature verification", () => {
  it("accepts a signature over the exact raw body and records the arrival", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(updates).toHaveLength(1);
    expect(updates[0].path).toBe(`subAccounts/${SUB}`);
    expect(
      updates[0].data["paystackConnectionMeta.webhookSeenAt"],
    ).toBeInstanceOf(Date);
  });

  it("401s a body tampered by one byte after signing, and writes nothing", async () => {
    const signature = sign(BODY);
    const res = await call({ body: BODY.replace("ref_1", "ref_2"), signature });
    expect(res.status).toBe(401);
    expect(updates).toEqual([]);
  });

  it("401s a signature made with someone else's key", async () => {
    const res = await call({ signature: sign(BODY, OTHER_KEY) });
    expect(res.status).toBe(401);
    expect(updates).toEqual([]);
  });

  it("401s a missing signature header rather than treating it as absent-and-fine", async () => {
    const res = await call({ signature: null });
    expect(res.status).toBe(401);
    expect(updates).toEqual([]);
  });

  it("401s a wrong-length signature without throwing", async () => {
    // timingSafeEqual throws on unequal lengths; an exception here would be a
    // 500 and make Paystack retry a forgery forever.
    const res = await call({ signature: "abc" });
    expect(res.status).toBe(401);
    expect(updates).toEqual([]);
  });

  it("verifies against THIS tenant's key, not the deployment's", async () => {
    process.env.PAYSTACK_SECRET_KEY = OTHER_KEY;
    const res = await call({ signature: sign(BODY, OTHER_KEY) });
    expect(res.status).toBe(401);
    delete process.env.PAYSTACK_SECRET_KEY;
  });
});

describe("no connection", () => {
  it("drops the event with a 200 so the operator's endpoint isn't auto-disabled", async () => {
    secretDoc = undefined;
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, ignored: "not_connected" });
    expect(updates).toEqual([]);
  });

  it("does not treat a connection doc with no key as connected", async () => {
    secretDoc = {};
    const res = await call();
    expect(await res.json()).toEqual({ received: true, ignored: "not_connected" });
    expect(updates).toEqual([]);
  });
});
