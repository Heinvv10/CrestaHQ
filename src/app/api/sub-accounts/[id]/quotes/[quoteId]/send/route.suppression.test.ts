import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Quote / invoice send against the sub-account's suppression list. The route,
 * the send service and `sendEmail` run for real; the suppression doc is read
 * from the seam's in-memory Firestore, everything else from the quote harness.
 * A human sent this, so the refusal is a 422 naming the address and reason,
 * and the quote is left unsent (no lifecycle write, no side-effects).
 */

const h = () => import("./send-test-harness");
const s = () => import("@/test/email-suppression-seam");
vi.mock("firebase-admin/firestore", async () => (await h()).firestoreMock());
vi.mock("@/lib/firebase/admin", async () => {
  const { fakeDb } = await h();
  const { mem } = await s();
  return {
    getAdminDb: () => ({
      ...fakeDb,
      doc: (path: string) =>
        path.includes("/emailSuppressions/") ? mem.db.doc(path) : fakeDb.doc(path),
    }),
  };
});
vi.mock("@/lib/auth/require-tenancy", async () => (await h()).tenancyMock());
vi.mock("@/lib/auth/territory-filter", async () => (await h()).territoryMock());
vi.mock("@/lib/quotes/token", async () => (await h()).tokenMock());
vi.mock("@/lib/quotes/email", async () => (await h()).emailMock());
vi.mock("@/lib/quotes/lifecycle", async () => (await h()).lifecycleMock());
vi.mock("@/lib/comms/smtp", async () => (await s()).seamMocks.smtp());
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));

const { SUB_ID, baseQuote, callJson, fireQuoteTrigger, resetHarness, state } = await h();
const { SMTP_SUB, resetSeam, suppress, wireRecipients } = await s();
const { POST } = await import("./route");

beforeEach(() => {
  resetHarness();
  resetSeam();
  state.subDoc = { ...SMTP_SUB, name: "Acme Plumbing", paypalConfig: { username: "acme" } };
});

describe.each(["quote", "invoice"])("%s send", (kind) => {
  beforeEach(() => {
    state.quoteDoc = baseQuote({ kind });
  });

  it("sends to an address that is not suppressed", async () => {
    const { status } = await callJson(POST);
    expect(status).toBe(200);
    expect(wireRecipients()).toEqual(["recipient@example.com"]);
  });

  it("refuses a suppressed recipient with a visible reason and leaves it unsent", async () => {
    suppress("recipient@example.com", SUB_ID);
    const { status, body } = await callJson(POST);
    expect(status).toBe(422);
    expect(body.error).toContain("recipient@example.com");
    expect(body.error).toContain("hard bounce");
    expect(wireRecipients()).toEqual([]);
    expect(state.quoteUpdates).toEqual([]);
    expect(fireQuoteTrigger).not.toHaveBeenCalled();
  });
});
