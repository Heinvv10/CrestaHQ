import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Both sub-account creation sites write `webVoiceEnabledByAgency: false` and
 * `dialerEnabledByAgency: false` explicitly (feature-gates.md step 2).
 * Real creation code over the in-memory Firestore; Firebase Auth recorded.
 */

vi.mock("@/lib/firebase/admin", async () => {
  const base = (await import("@/test/gbp-sync-store")).adminMock();
  let n = 0;
  return {
    ...base,
    getAdminAuth: () => ({
      createUser: async () => ({ uid: `uid_new_${++n}` }),
      setCustomUserClaims: async () => undefined,
      deleteUser: async () => undefined,
      updateUser: async () => undefined,
      getUserByEmail: async () => {
        throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
      },
    }),
  };
});
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/comms/resend", () => ({ emailIsConfigured: () => false, sendEmail: async () => undefined }));

import { mem } from "@/test/gbp-sync-store";
import { createSubAccountForAgency } from "./sub-accounts-service";
import { POST as signup } from "@/app/api/auth/signup/route";

beforeEach(() => {
  mem.clear();
  delete process.env.BOOTSTRAP_ADMIN_EMAIL;
});

describe("a new sub-account ships with Web Voice and the dialer off", () => {
  it("via the agency create path", async () => {
    const { subAccountId } = await createSubAccountForAgency({
      agencyId: "ag_1", uid: "uid_owner", email: "owner@example.com", displayName: "Owner",
      name: "Fixture", slug: "", timezone: "UTC", accountContact: null,
    });
    const doc = mem.read(`subAccounts/${subAccountId}`)!;
    expect(doc.webVoiceEnabledByAgency).toBe(false);
    expect(doc.dialerEnabledByAgency).toBe(false);
  });

  it("via the first signup (agency owner bootstrap)", async () => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = "owner@example.com";
    const res = await signup(
      new Request("http://127.0.0.1:3100/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@example.com", password: "secret123" }),
      }),
    );
    expect(res.status).toBe(200);
    const docs = mem.list("subAccounts");
    expect(docs).toHaveLength(1);
    expect(docs[0].webVoiceEnabledByAgency).toBe(false);
    expect(docs[0].dialerEnabledByAgency).toBe(false);
  });
});
