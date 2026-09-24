import { beforeEach, describe, expect, it, vi } from "vitest";
import twilio from "twilio";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The MCTB voice webhook through the real POST → resolveVoiceRoute →
 * readSubAccountSecret → twilio.validateRequest, on an in-memory Firestore.
 *
 * Pins which token the signature is checked against once #198 moved Twilio
 * auth tokens into `private/twilioCredentials`: the private doc wins over a
 * legacy `twilioConfig.authToken` left on the parent. That is the state the
 * E2E fixture primary was in after the private-credentials migration — the
 * missed-call fixture seeded only the legacy field, the private doc held a
 * different token, and every signed request got 403.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { POST } = await import("./route");

const URL_ = "https://crm.example.test/api/webhooks/twilio/voice";
const OUR_NUMBER = "+15017122661";
const FORWARD_TO = "+15551234567";

const params = { To: OUR_NUMBER, From: "+15005550006", CallSid: "CAtest0001" };

function post(token: string) {
  const sig = twilio.getExpectedTwilioSignature(token, URL_, params);
  return POST(
    new Request(URL_, {
      method: "POST",
      headers: { "x-twilio-signature": sig, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    }),
  );
}

function seedSubAccount(twilioConfig: Record<string, unknown>) {
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    missedCallTextBackEnabledByAgency: true,
    twilioConfig: {
      enabled: true,
      accountSid: "AC_fake",
      fromNumber: OUR_NUMBER,
      missedCall: { enabled: true, forwardTo: FORWARD_TO, ringTimeoutSec: 20 },
      ...twilioConfig,
    },
  });
}

beforeEach(() => mem.clear());

describe("twilio voice webhook — which auth token signs", () => {
  it("a stale private token outranks the legacy field: signing with the legacy token is 403", async () => {
    seedSubAccount({ authToken: "tok_legacy" });
    mem.seed("subAccounts/sa1/private/twilioCredentials", { authToken: "tok_private" });

    expect((await post("tok_legacy")).status).toBe(403);
  });

  it("the token in private/twilioCredentials validates and dials forwardTo", async () => {
    seedSubAccount({ authTokenSet: true });
    mem.seed("subAccounts/sa1/private/twilioCredentials", { authToken: "tok_private" });

    const res = await post("tok_private");
    expect(res.status).toBe(200);
    const twiml = await res.text();
    expect(twiml).toContain("<Dial");
    expect(twiml).toContain(FORWARD_TO);
  });

  it("an unmigrated sub-account (legacy field only) still validates", async () => {
    seedSubAccount({ authToken: "tok_legacy" });

    expect((await post("tok_legacy")).status).toBe(200);
  });
});
