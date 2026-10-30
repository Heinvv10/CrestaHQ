import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Broadcast step with open + click tracking (W4 PR2): real route → real
 * instrumentation → real sendEmail → SMTP wire, over an in-memory Firestore.
 *
 *   - tracking off (absent or both false) → the HTML on the wire is the exact
 *     string the step sent before tracking existed;
 *   - clicks on → http(s) links point at /t/c/, their destinations are stored
 *     under broadcasts/b1/links BEFORE the send, the unsubscribe, mailto: and
 *     tel: links stay as they were, and the plain-text part is untouched;
 *   - opens on → one pixel at the end of the body.
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

process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";

const { SA, AGENCY, SMTP_SUB, mem, resetSeam, smtpSend } = await s();
const { POST } = await import("./route");
const { verifyClickToken, verifyOpenToken } = await import("@/lib/broadcasts/tracking-token");

const BODY = [
  "Hi {{contact.firstName}}",
  `<a href="{{contact.customFields.portal}}">Your portal</a>`,
  `<a class="btn" HREF='https://shop.example/x?a=1&amp;b=2'>Shop</a>`,
  `<a href="mailto:help@shop.example">Mail us</a> <a href="tel:+27110000000">Call</a>`,
  `<a href="https://shop.example/x?a=1&b=2">Again</a> <a href="/relative">Rel</a>`,
  "{{unsubscribeLink}}",
].join("\n");

/** What the step sent for BODY before tracking existed — byte for byte. */
const UNTRACKED_HTML =
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px;">` +
  `Hi Thandi<br>` +
  `<a href="https://portal.example/p?u=c1&amp;t=x">Your portal</a><br>` +
  `<a class="btn" HREF='https://shop.example/x?a=1&amp;b=2'>Shop</a><br>` +
  `<a href="mailto:help@shop.example">Mail us</a> <a href="tel:+27110000000">Call</a><br>` +
  `<a href="https://shop.example/x?a=1&b=2">Again</a> <a href="/relative">Rel</a><br>` +
  `<a href="https://app.test/u/c1">Unsubscribe</a>` +
  `</body></html>`;

function seed(emailTracking?: Record<string, boolean>) {
  resetSeam();
  mem.seed(`subAccounts/${SA}`, {
    ...SMTP_SUB,
    broadcastsEnabledByAgency: true,
    ...(emailTracking ? { emailTracking } : {}),
  });
  mem.seed(`agencies/${AGENCY}`, {});
  mem.seed("message_templates/t1", { subject: "News", body: BODY });
  mem.seed("contacts/c1", {
    name: "Thandi",
    email: "thandi@example.co.za",
    emailOptedOut: false,
    customFields: { portal: "https://portal.example/p?u=c1&t=x" },
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
  mem.seed("broadcasts/b1/sends/c1", { status: "queued", skippedReason: null });
}

async function step() {
  return POST(
    new Request("https://app.test/api/broadcasts/email/step", {
      method: "POST",
      headers: { "upstash-signature": "sig" },
      body: JSON.stringify({ broadcastId: "b1", contactId: "c1" }),
    }),
  );
}

const wire = () => smtpSend.mock.calls.map(([, m]) => m as unknown as { html: string; text: string });
const hrefs = (html: string) => [...html.matchAll(/href=["']?([^"'\s>]+)/gi)].map((m) => m[1]!);

beforeEach(() => seed());

describe("broadcast step — tracking off", () => {
  it("sends the untracked HTML byte for byte when the setting is absent", async () => {
    await step();
    expect(wire()).toHaveLength(1);
    expect(wire()[0]!.html).toBe(UNTRACKED_HTML);
    expect(mem.list("broadcasts/b1/links")).toEqual([]);
  });

  it("sends the untracked HTML byte for byte when both switches are false", async () => {
    seed({ opens: false, clicks: false });
    await step();
    expect(wire()[0]!.html).toBe(UNTRACKED_HTML);
    expect(mem.list("broadcasts/b1/links")).toEqual([]);
  });
});

describe("broadcast step — clicks on", () => {
  beforeEach(() => seed({ clicks: true }));

  it("routes http(s) links through /t/c/ and stores each destination before sending", async () => {
    await step();
    const { html, text } = wire()[0]!;
    const links = hrefs(html);
    const tracked = links.filter((h) => h.startsWith("https://app.test/t/c/"));
    // The portal link (an escaped merge value), then "Shop" (entity-escaped)
    // and "Again" — the same URL, so one stored link for both.
    expect(tracked).toHaveLength(3);
    const keys = tracked.map((h) => verifyClickToken(h.slice("https://app.test/t/c/".length)));
    expect(keys.every((k) => k?.broadcastId === "b1" && k.contactId === "c1")).toBe(true);
    expect(keys[1]!.linkKey).toBe(keys[2]!.linkKey);
    expect(mem.read(`broadcasts/b1/links/${keys[0]!.linkKey}`)).toMatchObject({
      url: "https://portal.example/p?u=c1&t=x",
    });
    expect(mem.read(`broadcasts/b1/links/${keys[1]!.linkKey}`)).toMatchObject({
      url: "https://shop.example/x?a=1&b=2",
      agencyId: AGENCY,
      subAccountId: SA,
    });
    expect(mem.list("broadcasts/b1/links")).toHaveLength(2);
    // The rest of the tag survives the rewrite.
    expect(html).toContain(`<a class="btn" href="https://app.test/t/c/`);
    expect(text).not.toContain("/t/c/");
  });

  it("never rewrites the unsubscribe, mailto:, tel: or relative links", async () => {
    await step();
    const links = hrefs(wire()[0]!.html);
    expect(links).toContain("https://app.test/u/c1");
    expect(links).toContain("mailto:help@shop.example");
    expect(links).toContain("tel:+27110000000");
    expect(links).toContain("/relative");
    expect(wire()[0]!.html).not.toContain("<img");
  });

  it("sends nothing and releases the claim when a link doc can't be written", async () => {
    const realGetAll = mem.db.getAll.bind(mem.db);
    const spy = vi.spyOn(mem.db, "getAll").mockRejectedValueOnce(new Error("firestore down"));
    const res = await step();
    expect(res.status).toBe(500);
    expect(wire()).toHaveLength(0);
    expect(mem.read("broadcasts/b1/sends/c1")).toMatchObject({ status: "queued" });
    expect(mem.read("broadcasts/b1/sends/c1")!.claimId).toBeUndefined();
    spy.mockImplementation(realGetAll);
  });
});

describe("broadcast step — opens on", () => {
  it("appends one pixel for this recipient and leaves the links alone", async () => {
    seed({ opens: true });
    await step();
    const { html } = wire()[0]!;
    const pixels = [...html.matchAll(/<img src="https:\/\/app\.test\/t\/o\/([^"]+)"/g)];
    expect(pixels).toHaveLength(1);
    expect(verifyOpenToken(pixels[0]![1]!)).toEqual({ broadcastId: "b1", contactId: "c1" });
    expect(html.endsWith(`width:1px;height:1px;border:0;" /></body></html>`)).toBe(true);
    expect(html.replace(/<img [^>]+\/>/, "")).toBe(UNTRACKED_HTML);
  });
});
