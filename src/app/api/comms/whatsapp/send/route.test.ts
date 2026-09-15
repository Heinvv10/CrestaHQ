import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-handler tests for the manual WhatsApp send, covering ONE thing: what
 * the operator is told when a bridge rail refuses.
 *
 * This file exists because blind review deleted the entire refusal branch and
 * all 831 tests still passed. The status code, the message lookup and the
 * fallback chain were pure survivors — the wiring was untested while the
 * helper beside it had three tests of its own.
 *
 * Only the failure path is exercised. Nothing after the refusal branch runs,
 * so the fakes stop where the handler does.
 */

const requireUid = vi.fn();
const requireContactAccessible = vi.fn();
const checkWhatsappReadiness = vi.fn();
const dispatchWhatsappSend = vi.fn();
const getChannelConfig = vi.fn();
let subAccountDoc: Record<string, unknown> | undefined;
// What the handler wrote to contacts/{id}/whatsappMessages/{sid}. Captured
// because the attachment marker on that row is the only record that a file
// went out at all — the caption alone cannot say.
let messageRow: Record<string, unknown> | undefined;
let activityRow: Record<string, unknown> | undefined;

vi.mock("@/lib/comms/route-auth", () => ({
  requireUid: (...a: unknown[]) => requireUid(...a),
  requireContactAccessible: (...a: unknown[]) => requireContactAccessible(...a),
}));
vi.mock("@/lib/comms/whatsapp/readiness", () => ({
  checkWhatsappReadiness: (...a: unknown[]) => checkWhatsappReadiness(...a),
}));
vi.mock("@/lib/comms/whatsapp/send-dispatch", () => ({
  dispatchWhatsappSend: (...a: unknown[]) => dispatchWhatsappSend(...a),
}));
vi.mock("@/lib/comms/ai/agent", () => ({
  getChannelConfig: (...a: unknown[]) => getChannelConfig(...a),
}));
vi.mock("@/lib/comms/twilio", () => ({
  sendWhatsappForSubAccount: vi.fn(),
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: vi.fn(),
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: () => ({
      get: async () => ({
        exists: subAccountDoc !== undefined,
        data: () => subAccountDoc,
      }),
    }),
    collection: () => ({
      doc: () => ({
        collection: (name: string) => ({
          add: async (data: Record<string, unknown>) => {
            if (name === "activities") activityRow = data;
          },
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
    new Request("https://crm.test/api/comms/whatsapp/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  messageRow = undefined;
  activityRow = undefined;
  subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "bridge" };
  requireUid.mockReturnValue({ uid: "u1" });
  requireContactAccessible.mockResolvedValue({
    id: "c1",
    subAccountId: "sa1",
    phone: "+27821234567",
    whatsappOptedOut: false,
  });
  checkWhatsappReadiness.mockResolvedValue({ ready: true, provider: "bridge" });
  getChannelConfig.mockResolvedValue(null);
});

describe("POST /api/comms/whatsapp/send — rail refusals", () => {
  it("answers 409 with operator wording, not 502 with a rail name", async () => {
    dispatchWhatsappSend.mockResolvedValue({
      ok: false,
      provider: "bridge",
      refusedBy: "consecutive_cap",
      error:
        "WhatsApp bridge 422: consecutive_cap: 3 unanswered messages already sent to this contact (cap 3)",
    });

    const res = await post({ contactId: "c1", body: "hi" });
    const json = await res.json();

    // 502 says the gateway broke. Nothing broke — and a 5xx invites proxies
    // and retry logic to try again, which is what the rail exists to stop.
    expect(res.status).toBe(409);
    expect(json.code).toBe("consecutive_cap");
    expect(json.error).toMatch(/replied/i);
    expect(json.error).not.toContain("consecutive_cap");
    expect(json.error).not.toContain("422");
  });

  it("falls back to the provider's own words for a rail we have not worded", async () => {
    dispatchWhatsappSend.mockResolvedValue({
      ok: false,
      provider: "bridge",
      refusedBy: "some_future_rail",
      error: "WhatsApp bridge 422: some_future_rail: a new limit",
    });

    const res = await post({ contactId: "c1", body: "hi" });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("some_future_rail");
    // Raw provider words beat "couldn't send" for a rail nobody has worded.
    expect(json.error).toContain("a new limit");
  });

  it("still answers 502 for a genuine failure that named no rail", async () => {
    dispatchWhatsappSend.mockResolvedValue({
      ok: false,
      provider: "bridge",
      error: "connection reset",
    });

    const res = await post({ contactId: "c1", body: "hi" });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBeUndefined();
  });
});

describe("POST /api/comms/whatsapp/send — attachments", () => {
  const attachment = {
    filename: "report.png",
    contentType: "image/png",
    dataBase64: "AAEC",
  };

  it("forwards a well-formed attachment to the dispatcher", async () => {
    dispatchWhatsappSend.mockResolvedValue({
      ok: true,
      provider: "bridge",
      messageId: "3EB0",
    });

    const res = await post({ contactId: "c1", body: "here it is", attachment });
    expect(res.status).toBe(200);
    expect(dispatchWhatsappSend).toHaveBeenCalledWith(
      expect.objectContaining({ attachment }),
    );
  });

  it("records the file on the thread row as `media`, and never the bytes", async () => {
    // A thread showing only the caption cannot answer "did the report
    // actually go?" — the first question asked when a prospect says it never
    // arrived. The bytes must not be on the row: it is read by the UI and is
    // not a place to park half a megabyte. (The Storage copy and its path are
    // covered end to end in route.media.test.ts; the bucket is unconfigured
    // here, so the row records the drop instead.)
    dispatchWhatsappSend.mockResolvedValue({
      ok: true,
      provider: "bridge",
      messageId: "3EB0",
    });

    await post({ contactId: "c1", body: "here it is", attachment });
    expect(messageRow?.mediaDropped).toBe("fetch_failed");
    expect(messageRow).not.toHaveProperty("attachment");
    expect(JSON.stringify(messageRow)).not.toContain("AAEC");
    expect(activityRow?.content).toContain("report.png");
  });

  it("writes no media field for a plain text send", async () => {
    dispatchWhatsappSend.mockResolvedValue({
      ok: true,
      provider: "bridge",
      messageId: "3EB0",
    });

    await post({ contactId: "c1", body: "hi" });
    expect(messageRow).not.toHaveProperty("media");
    expect(messageRow).not.toHaveProperty("mediaDropped");
    expect(messageRow).not.toHaveProperty("attachment");
  });

  it("answers 4xx when the bridge rejects the file, not 502", async () => {
    // 502 says the gateway broke. Nothing broke — the file is too big, and the
    // operator can send a smaller one. A 5xx also invites proxies and retry
    // logic to try again, which reproduces the same rejection.
    dispatchWhatsappSend.mockResolvedValue({
      ok: false,
      provider: "bridge",
      providerErrorCode: "media_too_large",
      error:
        "WhatsApp bridge 413: media_too_large: attachment is 9000000 bytes; the limit is 8388608",
      providerOutcome: "DEFINITELY_REJECTED",
    });

    const res = await post({ contactId: "c1", body: "here it is", attachment });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe("media_too_large");
  });

  it("does NOT answer 400 for a code that arrived with an ambiguous outcome", async () => {
    // 400 tells the operator to fix it and send again. That is only safe when
    // the provider is certain nothing was delivered; on an ambiguous result it
    // is an invitation to double-message the contact.
    dispatchWhatsappSend.mockResolvedValue({
      ok: false,
      provider: "bridge",
      providerErrorCode: "media_too_large",
      error: "WhatsApp bridge 502: media_too_large",
      providerOutcome: "AMBIGUOUS",
    });

    const res = await post({ contactId: "c1", body: "here it is", attachment });
    expect(res.status).not.toBe(400);
  });

  it("rejects a half-filled attachment instead of sending an unnamed blob", async () => {
    for (const partial of [
      { contentType: "image/png", dataBase64: "AAEC" },
      { filename: "report.png", dataBase64: "AAEC" },
      { filename: "report.png", contentType: "image/png" },
      { filename: " ", contentType: "image/png", dataBase64: "AAEC" },
    ]) {
      const res = await post({
        contactId: "c1",
        body: "here it is",
        attachment: partial,
      });
      expect(res.status).toBe(400);
      expect(dispatchWhatsappSend).not.toHaveBeenCalled();
    }
  });
});
