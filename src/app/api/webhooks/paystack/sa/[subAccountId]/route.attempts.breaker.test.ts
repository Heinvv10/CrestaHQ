import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  KEY,
  LIVE_KEY,
  SA,
  mem,
  seedAttempt,
  seedInvoice,
  seedSub,
  stubPaystack,
  verified,
  type PaystackCall,
} from "@/test/paystack-links-harness";

/**
 * Ported from the PR #188 round-5 breaker repros (BREAK-2, -3, -4). Each one
 * drives the real routes end to end — create the link, open the pay page,
 * start checkout, change the connection, deliver the webhook — over the
 * in-memory Firestore. Only Paystack's HTTP API and the invoice fan-out are
 * stubbed.
 *
 *   BREAK-2  live invoice link, key switched to test, test card pays →
 *            the real invoice must not be marked paid.
 *   BREAK-3  live checkout open, Paystack disconnected, customer pays →
 *            flagged for the operator, not dropped.
 *   BREAK-4  live checkout open, key switched, customer pays → flagged,
 *            and the old-key redeliveries stop (200), not 401 forever.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
const effects = vi.hoisted(() => ({
  recordQuoteActivity: vi.fn(async () => {}),
  fireQuoteTrigger: vi.fn(async () => {}),
  emitQuoteWebhook: vi.fn(async () => {}),
}));
vi.mock("@/lib/quotes/lifecycle", () => effects);
vi.mock("@/lib/reviews/request", () => ({ maybeSendReviewRequest: vi.fn(async () => {}) }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async (_req: Request, subAccountId: string) =>
    ({ uid: "u1", subAccountId, subAccountRole: "admin" }),
  requireSubAccountAdmin: async (_req: Request, subAccountId: string) =>
    ({ uid: "u1", subAccountId, subAccountRole: "admin" }),
}));
vi.mock("@/lib/auth/territory-filter", () => ({ territoryGateForContact: async () => null }));

process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-16";
process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.com";

const { POST: WEBHOOK } = await import("./route");
const { GET: PAY_GET, POST: PAY_POST } = await import("@/app/pay/link/[token]/route");
const { POST: CREATE_LINK } = await import("@/app/api/sub-accounts/[id]/payment-links/route");
const { POST: CONNECT, DELETE: DISCONNECT } = await import(
  "@/app/api/sub-accounts/[id]/paystack-connection/route"
);

const TEST_KEY_2 = "sk_test_k9";

/** Paystack as seen by the app: whatever `verifyAs` says for verify calls. */
let verifyAs: (call: PaystackCall) => ReturnType<typeof verified> | { status: number; body: unknown };
let calls: PaystackCall[];
let started: string[];
/** Whether the attempt doc already existed when Paystack was asked to start. */
let attemptBeforeInitialize: boolean[];
let initializeFails = false;

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  started = [];
  attemptBeforeInitialize = [];
  initializeFails = false;
  // By default the customer is still on Paystack's checkout: no outcome yet.
  verifyAs = (c) => verified({ reference: c.path.split("/").pop()!, status: "ongoing" });
  calls = stubPaystack((c) => {
    if (c.path === "/transaction/initialize") {
      attemptBeforeInitialize.push(mem.read(`paymentAttempts/${String(c.body!.reference)}`) !== undefined);
      if (initializeFails) return { status: 400, body: { status: false, message: "Invalid email" } };
      started.push(String(c.body!.reference));
      return { body: { status: true, data: { authorization_url: "https://checkout.paystack.com/x", reference: c.body!.reference } } };
    }
    if (c.path === "/balance") return { body: { status: true, data: [{ currency: "ZAR", balance: 0 }] } };
    return verifyAs(c);
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function issueInvoiceLink(): Promise<{ id: string; token: string }> {
  seedInvoice();
  const res = await CREATE_LINK(
    new Request(`http://x/api/sub-accounts/${SA}/payment-links`, { method: "POST", body: JSON.stringify({ invoiceId: "inv1" }) }),
    { params: Promise.resolve({ id: SA }) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; token: string };
}

let ip = 0;
function payPage(token: string) {
  return PAY_GET(new Request(`https://crm.example.com/pay/link/${token}`), { params: Promise.resolve({ token }) });
}
function checkout(token: string) {
  return PAY_POST(
    new Request(`https://crm.example.com/pay/link/${token}`, {
      method: "POST",
      headers: { "x-forwarded-for": `10.7.0.${++ip}` },
      body: new URLSearchParams({ email: "payer@example.com" }),
    }),
    { params: Promise.resolve({ token }) },
  );
}

function connect(secretKey: string) {
  return CONNECT(
    new Request(`http://x/api/sub-accounts/${SA}/paystack-connection`, { method: "POST", body: JSON.stringify({ secretKey }) }),
    { params: Promise.resolve({ id: SA }) },
  );
}
function disconnect() {
  return DISCONNECT(new Request(`http://x/api/sub-accounts/${SA}/paystack-connection`, { method: "DELETE" }), {
    params: Promise.resolve({ id: SA }),
  });
}

function deliver(reference: string, signingKey: string) {
  const body = JSON.stringify({ event: "charge.success", data: { reference } });
  return WEBHOOK(
    new Request(`http://x/api/webhooks/paystack/sa/${SA}`, {
      method: "POST",
      headers: { "x-paystack-signature": createHmac("sha512", signingKey).update(body).digest("hex") },
      body,
    }),
    { params: Promise.resolve({ subAccountId: SA }) },
  );
}

const attempt = (reference: string) => mem.read(`paymentAttempts/${reference}`)!;

describe("the happy path still settles, and the attempt records it", () => {
  it("live link, live checkout, live webhook → invoice paid, attempt settled", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    expect(await (await payPage(link.token)).text()).not.toContain("TEST MODE");
    expect((await checkout(link.token)).status).toBe(303);
    const [ref] = started;
    expect(attempt(ref)).toMatchObject({ state: "open", mode: "live", subAccountId: SA, paymentLinkId: link.id, amountCents: 115000 });
    expect(attemptBeforeInitialize).toEqual([true]);
    verifyAs = () => verified({ reference: ref, amount: 115000, domain: "live" });
    expect((await deliver(ref, LIVE_KEY)).status).toBe(200);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
    expect(attempt(ref).state).toBe("settled");
  });
});

describe("BREAK-2 — a live→test key switch cannot settle a real invoice", () => {
  it("a live-issued invoice link opens no test checkout after the switch", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    expect((await connect(KEY)).status).toBe(200); // operator switches to a test key

    const page = await payPage(link.token);
    expect(await page.text()).not.toContain("TEST MODE");
    expect(page.status).toBe(410);
    expect((await checkout(link.token)).status).toBe(410);
    expect(calls.filter((c) => c.path === "/transaction/initialize")).toHaveLength(0);
    expect(mem.list("paymentAttempts")).toHaveLength(0);
  });

  it("a live attempt reported by the test key (same reference reused on the test account) is flagged, never paid", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    await connect(KEY);
    // Paystack's TEST account confirms a test-card success for that reference.
    verifyAs = () => verified({ reference: ref, amount: 115000, domain: "test" });

    expect((await deliver(ref, KEY)).status).toBe(200);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "sent" });
    expect(mem.read(`paymentLinks/${link.id}`)).toMatchObject({ status: "open" });
    expect(effects.fireQuoteTrigger).not.toHaveBeenCalled();
    expect(attempt(ref).state).toBe("flagged");
    expect(String(mem.read(`paymentLinks/${link.id}`)!.attention)).toContain(ref);
  });

  it("a test-mode transaction for a live attempt is flagged even when the key fingerprint matches", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    verifyAs = () => verified({ reference: ref, amount: 115000, domain: "test" });
    expect((await deliver(ref, LIVE_KEY)).status).toBe(200);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "sent" });
    expect(attempt(ref)).toMatchObject({ state: "flagged" });
  });
});

describe("BREAK-3 — a disconnect mid-checkout is flagged, not dropped", () => {
  it("the open attempt is flagged when Paystack is disconnected, with the reference and amount on the link", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;

    expect((await disconnect()).status).toBe(200);
    expect(attempt(ref)).toMatchObject({ state: "flagged" });
    const attention = String(mem.read(`paymentLinks/${link.id}`)!.attention);
    expect(attention).toContain(ref);
    expect(attention).toMatch(/ZAR\s1,150/);

    // The customer paid; Paystack delivers to an endpoint with no key.
    const res = await deliver(ref, LIVE_KEY);
    expect(res.status).toBe(200);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "sent" });
  });

  it("an attempt the disconnect missed is flagged when its webhook arrives", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    // The key is gone but the flag step never ran (crash between the two).
    await mem.db.doc(`subAccounts/${SA}/private/paystackConnection`).delete();
    expect(attempt(ref).state).toBe("open");

    const res = await deliver(ref, LIVE_KEY);
    expect(res.status).toBe(200);
    expect(attempt(ref).state).toBe("flagged");
    expect(String(mem.read(`paymentLinks/${link.id}`)!.attention)).toContain(ref);
  });
});

describe("BREAK-4 — a key switch mid-checkout is flagged, not retried forever", () => {
  it("switching key flags the open attempt; old-key redeliveries get 200, not 401", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;

    expect((await connect(TEST_KEY_2)).status).toBe(200);
    expect(attempt(ref)).toMatchObject({ state: "flagged" });
    expect(String(mem.read(`paymentLinks/${link.id}`)!.attention)).toContain(ref);

    const verifiesAtSwitch = calls.filter((c) => c.path.startsWith("/transaction/verify")).length;
    // Paystack keeps delivering the live payment, signed with the OLD key.
    for (let i = 0; i < 3; i++) expect((await deliver(ref, LIVE_KEY)).status).toBe(200);
    // Flagged once: redeliveries do not repeat the sentence.
    expect(String(mem.read(`paymentLinks/${link.id}`)!.attention).split(ref)).toHaveLength(2);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "sent" });
    // Nothing unverified was acted on: the deliveries sent no verify call.
    expect(calls.filter((c) => c.path.startsWith("/transaction/verify"))).toHaveLength(verifiesAtSwitch);
  });

  it("an attempt the switch missed is flagged by its first old-key delivery", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    mem.seed(`subAccounts/${SA}/private/paystackConnection`, { secretKey: TEST_KEY_2 });

    expect((await deliver(ref, LIVE_KEY)).status).toBe(200);
    expect(attempt(ref).state).toBe("flagged");
  });

  it("reconnecting the SAME key flags nothing, and the payment still settles", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    await connect(LIVE_KEY);
    expect(attempt(ref).state).toBe("open");
    expect(mem.read(`paymentLinks/${link.id}`)!.attention ?? null).toBeNull();
    verifyAs = () => verified({ reference: ref, amount: 115000, domain: "live" });
    await deliver(ref, LIVE_KEY);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
  });

  it("a flagged attempt still settles if the operator reconnects the key it used", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    await disconnect();
    expect(attempt(ref).state).toBe("flagged");
    await connect(LIVE_KEY);
    verifyAs = () => verified({ reference: ref, amount: 115000, domain: "live" });
    expect((await deliver(ref, LIVE_KEY)).status).toBe(200);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
    expect(attempt(ref).state).toBe("settled");
  });
});

describe("a bad signature is still never trusted", () => {
  it("401s a forged body whose reference has no attempt", async () => {
    seedSub(SA, LIVE_KEY);
    expect((await deliver("pl-link1-0123456789abcdef", "sk_live_forger")).status).toBe(401);
  });

  it("401s a forged body naming an attempt made with the CURRENT key", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    expect((await deliver(ref, "sk_live_forger")).status).toBe(401);
    expect(attempt(ref).state).toBe("open");
  });
});

describe("guards around the attempt record", () => {
  it("a key switched between page load and checkout is caught inside the attempt transaction", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    const realTx = mem.db.runTransaction;
    const spy = vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async (fn) => {
      // The operator switches to a test key after the pay page was checked.
      mem.seed(`subAccounts/${SA}/private/paystackConnection`, { secretKey: KEY });
      return realTx(fn);
    });
    expect((await checkout(link.token)).status).toBe(410);
    spy.mockRestore();
    expect(calls.filter((c) => c.path === "/transaction/initialize")).toHaveLength(0);
    expect(mem.list("paymentAttempts")).toHaveLength(0);
  });

  it("a key switch landing after the transaction read the key, before it committed, retries it", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    const realTx = mem.db.runTransaction;
    let first = true;
    const spy = vi.spyOn(mem.db, "runTransaction").mockImplementationOnce((fn) =>
      realTx(async (t) => {
        const result = await fn(t);
        if (first) {
          first = false;
          mem.seed(`subAccounts/${SA}/private/paystackConnection`, { secretKey: KEY });
        }
        return result;
      }),
    );
    expect((await checkout(link.token)).status).toBe(410);
    spy.mockRestore();
    expect(mem.list("paymentAttempts")).toHaveLength(0);
    expect(calls.filter((c) => c.path === "/transaction/initialize")).toHaveLength(0);
  });

  it("an attempt whose checkout Paystack refused to open is marked refused", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    initializeFails = true;
    expect((await checkout(link.token)).status).toBe(502);
    const [only] = mem.list("paymentAttempts");
    expect(only).toMatchObject({ state: "refused" });
    // A refused attempt is not open, so a later disconnect flags nothing.
    await disconnect();
    expect(mem.read(`paymentLinks/${link.id}`)!.attention ?? null).toBeNull();
  });

  it("a stale-key lookup never crosses sub-accounts: sa2's webhook naming sa1's attempt is 401", async () => {
    seedSub(SA, LIVE_KEY);
    seedSub("sa2", "sk_live_other");
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    const body = JSON.stringify({ event: "charge.success", data: { reference: ref } });
    const res = await WEBHOOK(
      new Request("http://x/api/webhooks/paystack/sa/sa2", {
        method: "POST",
        headers: { "x-paystack-signature": createHmac("sha512", "sk_live_forger").update(body).digest("hex") },
        body,
      }),
      { params: Promise.resolve({ subAccountId: "sa2" }) },
    );
    expect(res.status).toBe(401);
    expect(attempt(ref).state).toBe("open");
  });

  it("an old-key delivery for an attempt already settled flags nothing", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    verifyAs = () => verified({ reference: ref, amount: 115000, domain: "live" });
    await deliver(ref, LIVE_KEY);
    mem.seed(`subAccounts/${SA}/private/paystackConnection`, { secretKey: TEST_KEY_2 });
    expect((await deliver(ref, LIVE_KEY)).status).toBe(200);
    expect(attempt(ref).state).toBe("settled");
    expect(mem.read(`paymentLinks/${link.id}`)!.attention ?? null).toBeNull();
  });

  it("an unverified body cannot steer the attempt lookup to another path", async () => {
    seedSub(SA, LIVE_KEY);
    // A doc nested under paymentAttempts that looks like a stale attempt.
    seedAttempt("x/y/z", { paymentLinkId: "link1", secretKey: "sk_live_old" });
    expect((await deliver("x/y/z", "sk_live_forger")).status).toBe(401);
    expect(mem.read("paymentAttempts/x/y/z")).toMatchObject({ state: "open" });
    expect((await deliver("", "sk_live_forger")).status).toBe(401);
  });
});

describe("before the key changes, open attempts are settled or closed with the OLD key (round-1 review)", () => {
  const abandoned = (c: PaystackCall) => verified({ reference: c.path.split("/").pop()!, status: "abandoned" });

  it("RV-1: abandoned checkouts on a link that was then paid raise no flag on a key rotation", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    for (let i = 0; i < 3; i++) await checkout(link.token);
    const [r1, r2, r3] = started;
    verifyAs = () => verified({ reference: r3, amount: 115000, domain: "live" });
    await deliver(r3, LIVE_KEY);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });

    verifyAs = abandoned;
    expect((await connect("sk_live_k8")).status).toBe(200);
    expect(attempt(r1)).toMatchObject({ state: "refused" });
    expect(attempt(r2)).toMatchObject({ state: "refused" });
    expect(mem.read(`paymentLinks/${link.id}`)!.attention ?? null).toBeNull();
  });

  it("a checkout Paystack has no record of is closed, not flagged", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    verifyAs = () => ({ status: 404, body: { status: false, message: "Transaction reference not found" } });
    await disconnect();
    expect(attempt(ref)).toMatchObject({ state: "refused" });
    expect(mem.read(`paymentLinks/${link.id}`)!.attention ?? null).toBeNull();
  });

  it("RV-2: a payment made just before a key regeneration is recorded with the old key, not flagged", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    verifyAs = () => verified({ reference: ref, amount: 115000, domain: "live" });
    expect((await connect("sk_live_k8")).status).toBe(200);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
    expect(attempt(ref)).toMatchObject({ state: "settled" });
    expect(mem.read(`paymentLinks/${link.id}`)!.attention ?? null).toBeNull();
    const verifies = calls.filter((c) => c.path.startsWith("/transaction/verify"));
    expect(verifies.every((c) => c.auth === `Bearer ${LIVE_KEY}`)).toBe(true);
  });

  it("a payment made just before a disconnect is recorded before the key is deleted", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    verifyAs = () => verified({ reference: ref, amount: 115000, domain: "live" });
    await disconnect();
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
    expect(attempt(ref)).toMatchObject({ state: "settled" });
  });

  it("an attempt Paystack cannot answer for at switch time is flagged", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    verifyAs = () => ({ status: 500, body: { status: false, message: "upstream" } });
    await connect("sk_live_k8");
    expect(attempt(ref)).toMatchObject({ state: "flagged" });
    expect(String(mem.read(`paymentLinks/${link.id}`)!.attention)).toContain(ref);
  });

  it("the sweep asks only about attempts opened under the key being replaced", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    // Open under an older key the workspace no longer holds: the current key
    // cannot speak for it, so it must be flagged, never closed.
    seedAttempt("pl-old-0123456789abcdef", { paymentLinkId: link.id, secretKey: "sk_live_old", amountCents: 115000 });
    verifyAs = () => ({ status: 404, body: { status: false, message: "Transaction reference not found" } });
    await connect("sk_live_k8");
    expect(attempt("pl-old-0123456789abcdef")).toMatchObject({ state: "flagged" });
  });

  it("RV-3/4: a payer returning from Paystack after a switch or disconnect is told it is being confirmed, not to pay again", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    const back = () => PAY_GET(new Request(`https://crm.example.com/pay/link/${link.token}?reference=${ref}`), { params: Promise.resolve({ token: link.token }) });
    await connect(KEY);
    let page = await back();
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Confirming");
    await disconnect();
    page = await back();
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Confirming");
  });
});

describe("review round 2 — the sweep never closes a checkout that can still take money, and never blocks a disconnect", () => {
  const status = (st: string) => (c: PaystackCall) => verified({ reference: c.path.split("/").pop()!, status: st });

  it("F1: an abandoned checkout on an unpaid, active link is flagged on disconnect, not closed", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    verifyAs = status("abandoned");
    await disconnect();
    expect(attempt(ref)).toMatchObject({ state: "flagged" });
    expect(String(mem.read(`paymentLinks/${link.id}`)!.attention)).toContain(ref);
  });

  it("F1b: a failed checkout on an unpaid link is flagged on a key switch, not closed", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    verifyAs = status("failed");
    await connect("sk_live_k8");
    expect(attempt(ref)).toMatchObject({ state: "flagged" });
  });

  it("an abandoned checkout on a WITHDRAWN link is closed", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    await mem.db.doc(`paymentLinks/${link.id}`).update({ active: false });
    verifyAs = status("abandoned");
    await disconnect();
    expect(attempt(ref)).toMatchObject({ state: "refused" });
  });

  it("a reversed checkout is closed even on an unpaid link", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    verifyAs = status("reversed");
    await disconnect();
    expect(attempt(ref)).toMatchObject({ state: "refused" });
  });

  it("F2: an attempt settled while the sweep was asking Paystack is never overwritten as refused", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    await mem.db.doc(`paymentLinks/${link.id}`).update({ active: false });
    verifyAs = (c) => {
      // The payment lands and settles between the sweep's verify and its write.
      mem.seed(`paymentAttempts/${ref}`, { ...attempt(ref), state: "settled" });
      return status("abandoned")(c);
    };
    await disconnect();
    expect(attempt(ref)).toMatchObject({ state: "settled" });
  });

  it("F3: the key is deleted before Paystack is asked anything, so a hung Paystack cannot hold a disconnect", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    let keyStoredWhenAsked: boolean | null = null;
    let release: () => void = () => {};
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (!new URL(url).pathname.startsWith("/transaction/verify")) throw new Error(`unexpected ${url}`);
      keyStoredWhenAsked = mem.read(`subAccounts/${SA}/private/paystackConnection`) !== undefined;
      return new Promise((_, reject) => { release = () => reject(new TypeError("fetch failed")); });
    }));
    const pending = disconnect();
    await vi.waitFor(() => expect(keyStoredWhenAsked).not.toBeNull());
    expect(keyStoredWhenAsked).toBe(false);
    release();
    expect((await pending).status).toBe(200);
  });
});

describe("review round 3 — a failing sweep never skips the flag step", () => {
  it("G1: a Firestore error closing one attempt still sweeps the rest and flags what stayed open", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    for (let i = 0; i < 3; i++) await checkout(link.token);
    const [r1] = started;
    await mem.db.doc(`paymentLinks/${link.id}`).update({ active: false });
    verifyAs = (c) => verified({ reference: c.path.split("/").pop()!, status: "abandoned" });
    const realTx = mem.db.runTransaction;
    let failed = false;
    vi.spyOn(mem.db, "runTransaction").mockImplementation((fn) => {
      if (!failed) {
        failed = true;
        return Promise.reject(Object.assign(new Error("10 ABORTED: contention"), { code: 10 }));
      }
      return realTx(fn);
    });
    expect((await disconnect()).status).toBe(200);
    const states = started.map((r) => attempt(r).state);
    expect(states.filter((st) => st === "refused")).toHaveLength(2);
    expect(states.filter((st) => st === "flagged")).toHaveLength(1);
    expect(String(mem.read(`paymentLinks/${link.id}`)!.attention)).toContain(started[states.indexOf("flagged")]);
    void r1;
  });

  it("G2: reconnecting the same key while a disconnect is still sweeping leaves its attempts unflagged", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    let release: () => void = () => {};
    let asked = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/balance") return new Response(JSON.stringify({ status: true, data: [{ currency: "ZAR" }] }));
      asked = true;
      return new Promise<Response>((_, reject) => { release = () => reject(new TypeError("fetch failed")); });
    }));
    const pendingDisconnect = disconnect();
    await vi.waitFor(() => expect(asked).toBe(true));
    expect((await connect(LIVE_KEY)).status).toBe(200);
    release();
    await pendingDisconnect;
    expect(attempt(ref).state).toBe("open");
    expect(mem.read(`paymentLinks/${link.id}`)!.attention ?? null).toBeNull();
  });
  it("G2b: switching back to the original key while a key switch is still sweeping leaves its attempts unflagged", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    await checkout(link.token);
    const [ref] = started;
    let release: () => void = () => {};
    let asked = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/balance") return new Response(JSON.stringify({ status: true, data: [{ currency: "ZAR" }] }));
      asked = true;
      return new Promise<Response>((_, reject) => { release = () => reject(new TypeError("fetch failed")); });
    }));
    const pendingSwitch = connect("sk_live_k8");
    await vi.waitFor(() => expect(asked).toBe(true));
    expect((await connect(LIVE_KEY)).status).toBe(200);
    release();
    await pendingSwitch;
    expect(attempt(ref).state).toBe("open");
  });
});

describe("review round 4 — one failed flag write never leaves the others unflagged", () => {
  it("H1: a Firestore error flagging one attempt still flags the rest, errors the request, and a retry heals it", async () => {
    seedSub(SA, LIVE_KEY);
    const link = await issueInvoiceLink();
    for (let i = 0; i < 3; i++) await checkout(link.token);
    const realTx = mem.db.runTransaction;
    let failed = false;
    const spy = vi.spyOn(mem.db, "runTransaction").mockImplementation((fn) => {
      if (!failed) {
        failed = true;
        return Promise.reject(Object.assign(new Error("10 ABORTED: contention"), { code: 10 }));
      }
      return realTx(fn);
    });
    await expect(disconnect()).rejects.toThrow();
    spy.mockRestore();
    const states = started.map((r) => attempt(r).state);
    expect(states.filter((st) => st === "flagged")).toHaveLength(2);
    expect(states.filter((st) => st === "open")).toHaveLength(1);

    expect((await disconnect()).status).toBe(200);
    expect(started.map((r) => attempt(r).state)).toEqual(["flagged", "flagged", "flagged"]);
  });
});

