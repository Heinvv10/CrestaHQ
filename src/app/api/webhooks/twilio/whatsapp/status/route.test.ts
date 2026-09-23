import { beforeEach, describe, expect, it, vi } from "vitest";
import twilio from "twilio";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Twilio's WhatsApp statusCallback through the real POST, real signature
 * check (computed with Twilio's own helper), onto an in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { POST } = await import("./route");

const URL_ = "https://crm.example.test/api/webhooks/twilio/whatsapp/status";
const ROW = "contacts/c1/whatsappMessages/SM1";

function params(over: Record<string, string> = {}) {
  return {
    MessageSid: "SM1", MessageStatus: "undelivered", ErrorCode: "63016",
    From: "whatsapp:+27110000001", To: "whatsapp:+27821234567", ...over,
  };
}

function post(p: Record<string, string>, token = "tok_sa1") {
  const sig = twilio.getExpectedTwilioSignature(token, URL_, p);
  return POST(new Request(URL_, {
    method: "POST",
    headers: { "x-twilio-signature": sig, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(p).toString(),
  }));
}

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1", whatsappEnabledByAgency: true,
    twilioConfig: { enabled: true, authToken: "tok_sa1", whatsappFromNumber: "+27110000001" },
  });
  mem.seed("subAccounts/sa2", {
    agencyId: "ag1", whatsappEnabledByAgency: true,
    twilioConfig: { enabled: true, authToken: "tok_sa2", whatsappFromNumber: "+27110000002" },
  });
  mem.seed("contacts/c1", { subAccountId: "sa1", phone: "+27821234567" });
  mem.seed(ROW, { subAccountId: "sa1", direction: "outbound", status: "sent", error: null });
});

describe("twilio whatsapp status callback", () => {
  it("records an undelivered message as failed with its error code", async () => {
    expect((await post(params())).status).toBe(200);
    expect(mem.read(ROW)).toMatchObject({ status: "failed", error: "63016" });
  });

  it("a late delivered does not overwrite read", async () => {
    await post(params({ MessageStatus: "read", ErrorCode: "" }));
    await post(params({ MessageStatus: "delivered", ErrorCode: "" }));
    expect(mem.read(ROW)?.status).toBe("read");
  });

  it("rejects a bad signature and writes nothing", async () => {
    const res = await post(params(), "not_the_token");
    expect(res.status).toBe(403);
    expect(mem.read(ROW)?.status).toBe("sent");
  });

  it("a callback from another sub-account's sender never touches this row", async () => {
    await post(params({ From: "whatsapp:+27110000002" }), "tok_sa2");
    expect(mem.read(ROW)?.status).toBe("sent");
  });
});
