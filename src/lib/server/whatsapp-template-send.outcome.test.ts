import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A refused template send carries the provider's own verdict (PR 5b): the
 * mystery shop refunds a send Meta definitely refused and keeps one whose
 * outcome is ambiguous, and `attempted` alone cannot tell them apart.
 */

const dispatch = vi.fn();
vi.mock("@/lib/comms/whatsapp/template-dispatch", () => ({ dispatchWhatsappTemplateSend: (...a: unknown[]) => dispatch(...a) }));
vi.mock("@/lib/comms/twilio", () => ({ sendWhatsappTemplateForSubAccount: vi.fn() }));
vi.mock("@/lib/reviews/review-ask", () => ({ logInboxReviewAsk: async () => {} }));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => {} }));
// A refused send writes nothing: any Firestore use would throw here.
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));

const { sendWhatsappTemplate } = await import("./whatsapp-template-send");
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";

const input = {
  subAccount: {} as SubAccountDoc,
  tpl: { name: "t", displayName: "T", body: "Hi {{1}}", variables: [] } as unknown as WhatsappTemplateDoc,
  values: ["x"],
  contactId: "c1",
  contact: { agencyId: "ag1", subAccountId: "sa1", phone: "+27821234567" } as Contact,
  templateId: "t1",
  actorUid: "u1",
};

beforeEach(() => dispatch.mockReset());

describe("sendWhatsappTemplate refusals", () => {
  it.each(["DEFINITELY_REJECTED", "AMBIGUOUS"] as const)("carry the provider's outcome: %s", async (providerOutcome) => {
    dispatch.mockResolvedValue({ ok: false, error: "WhatsApp Cloud 400", attempted: true, providerOutcome, provider: "cloud" });
    expect(await sendWhatsappTemplate(input)).toEqual({
      ok: false, status: 409, error: "WhatsApp Cloud 400", attempted: true, providerOutcome,
    });
  });
});
