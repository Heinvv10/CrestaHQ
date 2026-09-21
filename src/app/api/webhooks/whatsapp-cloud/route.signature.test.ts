import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which app secrets the WhatsApp Cloud webhook trusts.
 *
 * Meta signs each POST with the secret of the app the WABA is subscribed to.
 * That may be a WhatsApp-only app (`WHATSAPP_APP_SECRET`) or the deployment's
 * Messenger/IG app (`META_APP_SECRET`); a body signed by anything else is
 * forged. The real signature check runs here — only the routing lookup is
 * stubbed, and it finds no workspace, so an accepted POST acks 200 unrouted.
 */

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => ({
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
    }),
  }),
}));

import { POST } from "./route";

const BODY = JSON.stringify({
  entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn_1" }, statuses: [] } }] }],
});

const sign = (secret: string) =>
  "sha256=" + crypto.createHmac("sha256", secret).update(BODY, "utf8").digest("hex");

async function post(signature: string) {
  const res = await POST(
    new Request("http://app.local/api/webhooks/whatsapp-cloud", {
      method: "POST",
      headers: { "x-hub-signature-256": signature },
      body: BODY,
    }),
  );
  return res.status;
}

beforeEach(() => {
  vi.stubEnv("META_APP_SECRET", "messenger-secret");
  vi.stubEnv("WHATSAPP_APP_SECRET", "whatsapp-secret");
});
afterEach(() => vi.unstubAllEnvs());

describe("whatsapp-cloud webhook signature", () => {
  it("accepts a body signed by the WhatsApp app", async () => {
    expect(await post(sign("whatsapp-secret"))).toBe(200);
  });

  it("still accepts a body signed by the Messenger/IG app", async () => {
    expect(await post(sign("messenger-secret"))).toBe(200);
  });

  it("refuses a body signed by any other secret", async () => {
    expect(await post(sign("someone-else"))).toBe(403);
  });

  it("refuses an unsigned body when no WhatsApp app secret is set", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", "");
    expect(await post(sign(""))).toBe(403);
  });
});
