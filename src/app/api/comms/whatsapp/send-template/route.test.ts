import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-handler tests for the template send's inbox bookkeeping (SP2 f).
 *
 * A template sent from the inbox must update the conversation index exactly
 * as a free-form reply does — outbound, preview = what was sent, bot paused —
 * or the thread stays in "awaiting reply" and the AI answers the customer's
 * reply over the operator. And it must do so ONLY after a successful send.
 */

const requireUid = vi.fn();
const requireContactAccessible = vi.fn();
const checkWhatsappReadiness = vi.fn();
const dispatchWhatsappTemplateSend = vi.fn();
const upsertConversationForMessage = vi.fn();
const docs: Record<string, Record<string, unknown> | undefined> = {};
let messageRow: Record<string, unknown> | undefined;

vi.mock("@/lib/comms/route-auth", () => ({
  requireUid: (...a: unknown[]) => requireUid(...a),
  requireContactAccessible: (...a: unknown[]) => requireContactAccessible(...a),
}));
vi.mock("@/lib/comms/whatsapp/readiness", () => ({
  checkWhatsappReadiness: (...a: unknown[]) => checkWhatsappReadiness(...a),
}));
vi.mock("@/lib/comms/whatsapp/template-dispatch", () => ({
  dispatchWhatsappTemplateSend: (...a: unknown[]) => dispatchWhatsappTemplateSend(...a),
}));
vi.mock("@/lib/comms/twilio", () => ({ sendWhatsappTemplateForSubAccount: vi.fn() }));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: (...a: unknown[]) => upsertConversationForMessage(...a),
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => ({ exists: docs[path] !== undefined, data: () => docs[path] }),
    }),
    collection: () => ({
      doc: () => ({
        collection: (name: string) => ({
          add: async () => undefined,
          doc: () => ({
            set: async (data: Record<string, unknown>) => {
              if (name === "whatsappMessages") messageRow = data;
            },
          }),
        }),
      }),
    }),
  }),
}));

import { POST } from "./route";

function post(body: unknown) {
  return POST(
    new Request("https://crm.test/api/comms/whatsapp/send-template", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  messageRow = undefined;
  for (const k of Object.keys(docs)) delete docs[k];
  docs["subAccounts/sa1"] = { name: "Acme Fibre", whatsappEnabledByAgency: true, whatsappProvider: "cloud" };
  docs["subAccounts/sa1/whatsappTemplates/t1"] = {
    name: "follow_up",
    displayName: "Follow-up",
    body: "Hi {{1}}, following up.",
    variables: [{ position: 1, label: "Name", sampleValue: "x", source: "manual", mergeTag: null }],
  };
  requireUid.mockReturnValue({ uid: "u1" });
  requireContactAccessible.mockResolvedValue({
    id: "c1",
    agencyId: "ag1",
    subAccountId: "sa1",
    name: "Thandi Mokoena",
    phone: "+27821234567",
    whatsappOptedOut: false,
  });
  checkWhatsappReadiness.mockResolvedValue({ ready: true, provider: "cloud" });
});

describe("POST /api/comms/whatsapp/send-template — conversation index", () => {
  it("mirrors a successful send into the conversation: outbound, rendered preview, bot paused", async () => {
    dispatchWhatsappTemplateSend.mockResolvedValue({ ok: true, provider: "cloud", messageId: "wamid.1" });

    const res = await post({ contactId: "c1", templateId: "t1", manualValues: { "1": "Thandi" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sid: "wamid.1" });
    expect(messageRow).toMatchObject({ direction: "outbound", body: "Hi Thandi, following up." });
    expect(upsertConversationForMessage).toHaveBeenCalledTimes(1);
    expect(upsertConversationForMessage).toHaveBeenCalledWith({
      contactId: "c1",
      subAccountId: "sa1",
      agencyId: "ag1",
      contactName: "Thandi Mokoena",
      contactPhone: "+27821234567",
      channel: "whatsapp",
      direction: "outbound",
      body: "Hi Thandi, following up.",
      pauseBot: true,
    });
  });

  it("labels the preview with the template name when the rendered text is empty", async () => {
    docs["subAccounts/sa1/whatsappTemplates/t1"] = {
      name: "blank", displayName: "Blank", body: "", variables: [],
    };
    dispatchWhatsappTemplateSend.mockResolvedValue({ ok: true, provider: "cloud", messageId: "wamid.2" });

    await post({ contactId: "c1", templateId: "t1" });

    expect(upsertConversationForMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "[Template: Blank]", direction: "outbound", pauseBot: true }),
    );
  });

  it("touches the conversation not at all when the send is refused", async () => {
    dispatchWhatsappTemplateSend.mockResolvedValue({
      ok: false,
      provider: "cloud",
      error: 'Template "follow_up" isn\'t approved on your Meta WhatsApp account yet.',
    });

    const res = await post({ contactId: "c1", templateId: "t1", manualValues: { "1": "Thandi" } });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("isn't approved");
    expect(upsertConversationForMessage).not.toHaveBeenCalled();
    expect(messageRow).toBeUndefined();
  });

  it("touches the conversation not at all when the provider throws", async () => {
    dispatchWhatsappTemplateSend.mockRejectedValue(new Error("Graph 500"));

    const res = await post({ contactId: "c1", templateId: "t1", manualValues: { "1": "Thandi" } });

    expect(res.status).toBe(502);
    expect(upsertConversationForMessage).not.toHaveBeenCalled();
  });
});
