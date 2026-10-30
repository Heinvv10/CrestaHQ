import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The broadcast step writes `emailEvents/{resendEmailId}` — the lookup the
 * Resend events webhook resolves a delivery event through — only when the
 * email went out through Resend. Real route → real sendEmail over an
 * in-memory Firestore; only Resend's client and the SMTP wire are faked.
 */

const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/comms/smtp", async (orig) => (await s()).seamMocks.smtp(orig));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  verifyQStashSignature: async () => true,
}));
vi.mock("@/lib/automations/unsubscribe-token", () => ({
  buildUnsubscribeUrl: (id: string) => `https://app.test/u/${id}`,
}));
vi.mock("@/lib/reviews/review-ask", () => ({ logIfReviewAsk: async () => undefined }));
/** Holds the settle back, to see the row as an event arriving before it would. */
const settle = vi.hoisted(() => ({ skip: false }));
vi.mock("@/lib/broadcasts/settle-send", async (orig) => {
  const real = await orig<typeof import("@/lib/broadcasts/settle-send")>();
  return {
    ...real,
    settleSend: (...a: Parameters<typeof real.settleSend>) =>
      settle.skip ? Promise.resolve(false) : real.settleSend(...a),
  };
});

const RESEND_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const resendSend = vi.hoisted(() =>
  vi.fn(async (_m: unknown) => ({ data: { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }, error: null })),
);
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (m: unknown) => resendSend(m) };
  },
}));

process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
process.env.RESEND_API_KEY = "re_test";
process.env.EMAIL_FROM = "Fixture <hi@platform.test>";

const { SA, AGENCY, SMTP_SUB, mem, resetSeam, smtpSend } = await s();
const { POST } = await import("./route");
const { recordBroadcastEmailLookup } = await import("@/lib/comms/email-events");

function seed(sub: Record<string, unknown>) {
  resetSeam();
  mem.seed(`subAccounts/${SA}`, { ...sub, broadcastsEnabledByAgency: true });
  mem.seed(`agencies/${AGENCY}`, {});
  mem.seed("message_templates/t1", { subject: "News", body: "Hi\n{{unsubscribeLink}}" });
  mem.seed("contacts/c1", {
    name: "Thandi",
    email: "thandi@example.co.za",
    emailOptedOut: false,
    agencyId: AGENCY,
    subAccountId: SA,
  });
  mem.seed("broadcasts/b1", {
    agencyId: AGENCY,
    subAccountId: SA,
    templateId: "t1",
    templateName: "News",
    status: "sending",
    totals: { queued: 1, sent: 0, skipped: 0, failed: 0 },
  });
  mem.seed("broadcasts/b1/sends/c1", {
    status: "queued",
    skippedReason: null,
    subAccountId: SA,
    resendMessageId: null,
    // The fan-out snapshot; the contact's address changed before the step ran.
    toEmail: "thandi.old@example.co.za",
  });
}

const step = () =>
  POST(
    new Request("https://app.test/api/broadcasts/email/step", {
      method: "POST",
      headers: { "upstash-signature": "sig" },
      body: JSON.stringify({ broadcastId: "b1", contactId: "c1" }),
    }),
  );

beforeEach(() => {
  resendSend.mockClear();
  settle.skip = false;
});

describe("broadcast step — Resend delivery-event lookup", () => {
  it("writes emailEvents/{resend id} naming the row, its tenant and an expiry", async () => {
    seed({ agencyId: AGENCY, name: "Platform sender" });
    await step();
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(mem.read("broadcasts/b1/sends/c1")).toMatchObject({ status: "sent", resendMessageId: RESEND_ID });
    const lookup = mem.read(`emailEvents/${RESEND_ID}`);
    expect(lookup).toMatchObject({
      kind: "broadcast",
      broadcastId: "b1",
      contactId: "c1",
      subAccountId: SA,
      agencyId: AGENCY,
      // The address the email went to (the live contact), not the fan-out snapshot.
      toEmail: "thandi@example.co.za",
    });
    expect(resendSend.mock.calls[0]![0]).toMatchObject({ to: "thandi@example.co.za" });
    const expiresMs = (lookup!.expiresAt as { toMillis: () => number }).toMillis();
    expect(expiresMs - Date.now()).toBeGreaterThan(89 * 24 * 3_600_000);
  });

  it("stamps the Resend id on the row with the lookup, before the settle", async () => {
    seed({ agencyId: AGENCY, name: "Platform sender" });
    settle.skip = true;
    await step();
    expect(mem.read("broadcasts/b1/sends/c1")).toMatchObject({ status: "queued", resendMessageId: RESEND_ID });
    expect(mem.read(`emailEvents/${RESEND_ID}`)).toBeDefined();
  });

  it("writes neither when the step no longer holds the claim", async () => {
    seed({ agencyId: AGENCY, name: "Platform sender" });
    mem.seed("broadcasts/b1/sends/c1", { status: "queued", claimId: "someone-else", subAccountId: SA, resendMessageId: null });
    const sendRef = mem.db.collection("broadcasts").doc("b1").collection("sends").doc("c1");
    const broadcastRef = mem.db.collection("broadcasts").doc("b1");
    await recordBroadcastEmailLookup({
      row: { sendRef, broadcastRef, claimId: "mine" } as unknown as Parameters<typeof recordBroadcastEmailLookup>[0]["row"],
      emailId: RESEND_ID,
      toEmail: "thandi@example.co.za",
      subAccountId: SA,
      agencyId: AGENCY,
    });
    expect(mem.read("broadcasts/b1/sends/c1")!.resendMessageId).toBeNull();
    expect(mem.list("emailEvents")).toEqual([]);
  });

  it("writes no lookup for an SMTP send", async () => {
    seed(SMTP_SUB);
    // An id that could pass for a Resend one: only the rail decides.
    smtpSend.mockResolvedValueOnce({ id: "smtp-0001" });
    await step();
    expect(smtpSend).toHaveBeenCalledTimes(1);
    expect(resendSend).not.toHaveBeenCalled();
    expect(mem.read("broadcasts/b1/sends/c1")).toMatchObject({ status: "sent" });
    expect(mem.list("emailEvents")).toEqual([]);
  });

  it("still settles the row sent when the lookup write fails", async () => {
    seed({ agencyId: AGENCY, name: "Platform sender" });
    const collection = mem.db.collection.bind(mem.db);
    const spy = vi.spyOn(mem.db, "collection").mockImplementation((name: string) => {
      if (name === "emailEvents") throw new Error("unavailable");
      return collection(name);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await step();
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect(mem.read("broadcasts/b1/sends/c1")).toMatchObject({ status: "sent", resendMessageId: RESEND_ID });
    expect(mem.read("broadcasts/b1")!.totals).toMatchObject({ sent: 1, queued: 0 });
  });
});
