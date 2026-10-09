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
// A refused send writes nothing; an accepted one's thread writes are recorded in order.
const writes = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/firebase/admin", () => {
  const sub = (name: string) => ({
    add: async () => void writes.push(name),
    doc: () => ({ set: async () => void writes.push(name) }),
  });
  return { getAdminDb: () => ({ collection: () => ({ doc: () => ({ collection: sub }) }) }) };
});

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

beforeEach(() => {
  dispatch.mockReset();
  writes.length = 0;
});

describe("sendWhatsappTemplate refusals", () => {
  it.each(["DEFINITELY_REJECTED", "AMBIGUOUS"] as const)("carry the provider's outcome: %s", async (providerOutcome) => {
    dispatch.mockResolvedValue({ ok: false, error: "WhatsApp Cloud 400", attempted: true, providerOutcome, provider: "cloud" });
    expect(await sendWhatsappTemplate(input)).toEqual({
      ok: false, status: 409, error: "WhatsApp Cloud 400", attempted: true, providerOutcome,
    });
  });
});

describe("onAccepted", () => {
  it("gets the provider's id before the thread is written; never on a refusal", async () => {
    dispatch.mockResolvedValue({ ok: true, messageId: "wamid.1", provider: "cloud" });
    const seen: string[] = [];
    const onAccepted = async (sid: string) => void seen.push(`${sid} after ${writes.length} writes`);
    expect(await sendWhatsappTemplate({ ...input, onAccepted })).toEqual({ ok: true, sid: "wamid.1" });
    expect(seen).toEqual(["wamid.1 after 0 writes"]);
    expect(writes).toEqual(["activities", "whatsappMessages"]);
    dispatch.mockResolvedValue({ ok: false, error: "x", attempted: true, providerOutcome: "AMBIGUOUS", provider: "cloud" });
    await sendWhatsappTemplate({ ...input, onAccepted });
    expect(seen).toHaveLength(1);
  });
});
