import { beforeEach, describe, expect, it, vi } from "vitest";

import { SA, SMTP_SUB, mem, smtpSend } from "@/test/email-suppression-seam";

/**
 * The delivery emails through the REAL `sendEmail` (SMTP path) and the real
 * entitlements service, over an in-memory Firestore. Only the SMTP wire and
 * the Conversations writer are stubbed. The community email's link is a live
 * sign-in as the buyer, so it must never be archived into the contact's
 * Conversations thread, where any staff member could use it; a download
 * email stays archived like any other mail to a customer.
 */

const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/comms/smtp", async (original) =>
  (await s()).seamMocks.smtp(original as () => Promise<Record<string, unknown>>),
);
vi.mock("@/lib/server/usage-meter", async (original) =>
  (await s()).seamMocks.usage(original as () => Promise<Record<string, unknown>>),
);
const recordEmailMessage = vi.hoisted(() =>
  vi.fn(async (_m: { body: string; subject: string }) => ({ inserted: true, contactId: "c1" })),
);
vi.mock("@/lib/server/email-conversations", () => ({ recordEmailMessage }));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn(async () => {}) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const { grantForOrder } = await import("@/lib/server/entitlements-service");

const DOWNLOAD = "https://files.example.com/guide.pdf";
const target = { orderId: "ord1", subAccountId: SA };

function seed(delivery: Record<string, unknown>) {
  mem.seed(`subAccounts/${SA}`, { ...SMTP_SUB, communityEnabledByAgency: true });
  mem.seed(`subAccounts/${SA}/communityGroups/g1`, {
    subAccountId: SA, agencyId: "ag1", name: "Fibre Club", slug: "fibre-club", access: "free", status: "published", memberCount: 0,
  });
  mem.seed("contacts/c1", { subAccountId: SA, agencyId: "ag1", email: "buyer@example.com" });
  mem.seed("orders/ord1", {
    agencyId: "ag1", subAccountId: SA, contactId: "c1", source: "product_link", status: "paid",
    currency: "zar", totalCents: 49_900, livemode: false, buyerEmail: "buyer@example.com", buyerName: null,
    lineItems: [{ productId: "p1", name: "Fibre club", description: "", unitPriceCents: 49_900, quantity: 1, isBump: false }],
    deliveries: [{ productId: "p1", delivery }],
  });
}

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("delivery emails and Conversations", () => {
  it("the community sign-in link is sent but never archived", async () => {
    seed({ type: "community", communityGroupId: "g1", courseId: null });
    expect(await grantForOrder(target)).toMatchObject({ delivered: 1, failed: 0 });

    expect(smtpSend).toHaveBeenCalledTimes(1);
    const sent = smtpSend.mock.calls[0][1] as unknown as { text: string };
    const token = new URL(sent.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;
    expect(token.length).toBeGreaterThan(20);
    // No Conversations row, so the token is nowhere a staff member can read it.
    expect(recordEmailMessage).not.toHaveBeenCalled();
  });

  it("a download link is archived to the contact's thread like any customer mail", async () => {
    seed({ type: "download", url: DOWNLOAD, label: "Get it" });
    await grantForOrder(target);

    expect(recordEmailMessage).toHaveBeenCalledTimes(1);
    expect(recordEmailMessage.mock.calls[0][0].body).toContain(DOWNLOAD);
  });
});
