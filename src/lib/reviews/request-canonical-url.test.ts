import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The review-request dispatcher reads the review link through the canonical
 * seam: the CONFIGURED URL only. A selected GBP listing's own link is a
 * proposal an admin may adopt — it is never sent on its own, and never
 * replaces a configured link in a message.
 */

vi.mock("@/lib/firebase/admin", async () => {
  const h = await import("@/test/reviews-request-harness");
  return { getAdminDb: () => h.fakeDb() };
});
vi.mock("@/lib/comms/twilio", async () => {
  const h = await import("@/test/reviews-request-harness");
  return {
    sendSmsForSubAccount: (...a: unknown[]) => h.sendSms(...(a as [])),
    sendWhatsappForSubAccount: (...a: unknown[]) => h.sendWhatsapp(...(a as [])),
    sendWhatsappTemplateForSubAccount: (...a: unknown[]) => h.sendWhatsappTemplate(...(a as [])),
    smsIsConfigured: () => h.smsIsConfigured(),
    subAccountTwilioIsConfigured: () => h.subAccountTwilioIsConfigured(),
    subAccountWhatsappIsConfigured: () => h.subAccountWhatsappIsConfigured(),
  };
});
vi.mock("@/lib/server/conversations-service", async () => {
  const h = await import("@/test/reviews-request-harness");
  return { upsertConversationForMessage: (...a: unknown[]) => h.upsertConversation(...(a as [])) };
});

import { AG, C, SA, SUB_PATH, docs, resetHarness, sendSms, setReviewCfg } from "@/test/reviews-request-harness";
import { maybeSendReviewRequest } from "./request";

const LISTING = "https://review.fixture.example/listing-link";
const send = () => maybeSendReviewRequest({ subAccountId: SA, agencyId: AG, contactId: C, trigger: "quote_paid" });
const withListingLink = () => void ((docs[SUB_PATH] as Record<string, unknown>).googleListing = { newReviewUri: LISTING });

beforeEach(resetHarness);

describe("which review link a request sends", () => {
  it("the configured one — never the listing's, even when they differ", async () => {
    withListingLink();
    expect(await send()).toEqual({ sent: true });
    const body = (sendSms.mock.calls[0] as unknown as [{ body: string }])[0].body;
    expect(body).toContain("https://g.page/r/acme/review");
    expect(body).not.toContain(LISTING);
  });

  it("with no configured link, a listing link alone sends nothing", async () => {
    setReviewCfg({ reviewUrl: "" });
    withListingLink();
    expect(await send()).toEqual({ sent: false, reason: "not_configured" });
    expect(sendSms).not.toHaveBeenCalled();
  });
});
