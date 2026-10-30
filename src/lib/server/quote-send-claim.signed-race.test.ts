import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A send racing the recipient's accept (adopted from the #446 breaker's
 * repro): the send read the quote unsigned and its email went out, the
 * recipient accepted (or signed) meanwhile, then the send's step 8 records.
 * It must not flip the accepted quote back to "sent" or rotate its link — a
 * signed quote flipped back could be signed a second time — and it reports
 * the send as changed. An invoice converted from a signed quote still sends
 * normally.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const { recordSendAndRelease, claimQuoteForSend } = await import("./quote-send-claim");

const SIGNATURE = { signerName: "Jane Doe", signedAsNumber: "Q-1", signerEmail: null, signedAt: new Date(), ipAddress: "1.1.1.1", userAgent: "ua", documentHash: "a".repeat(64), hashVersion: 1 };
const BASE = { subAccountId: "sa1", agencyId: "ag1", contactId: "c1", kind: "quote", quoteNumber: "Q-1", currency: "ZAR", lineItems: [{ id: "l", description: "x", quantity: 1, unitPrice: 10 }], globalDiscount: null, globalTaxPercent: null, termsAndNotes: "", billedToOrganization: null, billingAddress: null, validUntil: null, paymentDueDays: null };
const SENT_AT = new Date("2026-10-29T10:00:00Z");
const ref = () => mem.db.doc("quotes/q1") as never;
const record = (claim: Parameters<typeof recordSendAndRelease>[1]) =>
  recordSendAndRelease(ref(), claim, { sentAt: SENT_AT, viewedAt: null, publicTokenHash: "NEW" }, null);

beforeEach(() => mem.clear());

describe("a send whose quote was accepted while the email was out", () => {
  it("claimed (agent) send, signed meanwhile: stays accepted, keeps its link, claim released, changed", async () => {
    mem.seed("quotes/q1", { ...BASE, status: "viewed", publicTokenHash: "OLD", requireSignature: true, signature: null, viewedAt: "v" });
    const claimed = await claimQuoteForSend(ref(), mem.read("quotes/q1") as never);
    expect(claimed.ok).toBe(true);
    await mem.db.doc("quotes/q1").update({ status: "accepted", signature: SIGNATURE });

    expect(await record(claimed.ok ? claimed.claim : null)).toBe(true);
    const q = mem.read("quotes/q1")!;
    expect(q).toMatchObject({ status: "accepted", publicTokenHash: "OLD", signature: SIGNATURE, viewedAt: "v", sendingClaim: null });
    expect(q).not.toHaveProperty("sentAt");
  });

  it("unclaimed (member) send, accepted without a signature meanwhile: nothing of the send is written, changed", async () => {
    mem.seed("quotes/q1", { ...BASE, status: "accepted", publicTokenHash: "OLD", viewedAt: "v" });
    const before = mem.read("quotes/q1");
    expect(await record(null)).toBe(true);
    expect(mem.read("quotes/q1")).toEqual(before);
  });

  it("a signature on a quote whose status a stale writer flipped is still final", async () => {
    mem.seed("quotes/q1", { ...BASE, status: "sent", publicTokenHash: "OLD", signature: SIGNATURE });
    expect(await record(null)).toBe(true);
    expect(mem.read("quotes/q1")).toMatchObject({ status: "sent", publicTokenHash: "OLD" });
  });
});

describe("controls: the send is recorded", () => {
  it("an unsigned quote still open", async () => {
    mem.seed("quotes/q1", { ...BASE, status: "viewed", publicTokenHash: "OLD" });
    expect(await record(null)).toBe(false);
    expect(mem.read("quotes/q1")).toMatchObject({ status: "sent", publicTokenHash: "NEW", sentAt: SENT_AT });
  });

  it("the draft invoice converted from a signed quote", async () => {
    mem.seed("quotes/q1", { ...BASE, kind: "invoice", quoteNumber: "INV-1", status: "draft", publicTokenHash: "", signature: SIGNATURE });
    expect(await record(null)).toBe(false);
    expect(mem.read("quotes/q1")).toMatchObject({ status: "sent", publicTokenHash: "NEW", signature: SIGNATURE });
  });
});
