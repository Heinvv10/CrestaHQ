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
