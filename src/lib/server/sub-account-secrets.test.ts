import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Integration credentials must never sit on `subAccounts/{id}` — every active
 * member can read that doc with the client SDK (firestore.rules), and the
 * browser subscribes to all of it (sub-account-context.tsx). Driven through
 * the REAL connect routes and the REAL readers over an in-memory Firestore;
 * only the third-party APIs and the auth gate are stubbed.
 *
 * `member-visible` below is the whole parent doc, i.e. exactly what a
 * collaborator seat's client-SDK read returns.
 */

const mem = createMemoryFirestore();
const calls = vi.hoisted(() => ({ ghl: [] as string[], twilioClient: [] as string[] }));

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "u_admin" }),
  requireAgencyOwner: async () => ({ uid: "u_owner" }),
}));
vi.mock("twilio", () => ({
  default: (_sid: string, token: string) => {
    calls.twilioClient.push(token);
    return { messages: { create: vi.fn() } };
  },
}));
vi.mock("@/lib/comms/twilio-config", () => ({
  validateCredentials: async () => ({ ok: true, friendlyName: "Acme" }),
  autoConfigureInboundWebhook: async () => ({ ok: true, error: null }),
}));
vi.mock("@/lib/comms/meta", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/meta")>()),
  verifyMetaState: () => ({ subAccountId: "sa1" }),
  metaAppConfigured: () => true,
  metaRedirectUri: () => "https://app.test/api/meta/callback",
  exchangeCodeForUserToken: async () => "user-token",
  getGrantedScopes: async () => new Set(["pages_messaging"]),
  listMetaPages: async () => [
    {
      id: "page1",
      name: "Acme Page",
      accessToken: "EAA-page-secret",
      instagramBusinessAccountId: null,
      instagramUsername: null,
    },
  ],
  subscribePageToWebhook: async () => undefined,
}));
vi.mock("@/lib/import/ghl/client", async (importOriginal) => {
  const record = async (token: string) => {
    calls.ghl.push(token);
    return { contactTotal: 3, items: [], nextCursor: null, total: 0 };
  };
  return {
    ...(await importOriginal<typeof import("@/lib/import/ghl/client")>()),
    validateGhlAccess: record,
    listOpportunitiesPage: record,
    getPipelines: async () => [],
    getCustomFields: async () => [],
  };
});

const twilioRoute = await import("@/app/api/sub-accounts/[id]/twilio/route");
const metaCallback = await import("@/app/api/meta/callback/route");
const ghlConnect = await import("@/app/api/sub-accounts/[id]/import/ghl/connect/route");
const ghlPreview = await import("@/app/api/sub-accounts/[id]/import/ghl/preview/route");
const { getTwilioForSubAccount } = await import("@/lib/comms/twilio");
const { prepareMetaSend } = await import("@/lib/server/conversation-send/meta");
const { readSubAccountSecret, subAccountSecretPath } = await import("./sub-account-secrets");

const params = { params: Promise.resolve({ id: "sa1" }) };
const post = (body: unknown) =>
  new Request("https://app.test/x", { method: "POST", body: JSON.stringify(body) });
const memberVisible = () => JSON.stringify(mem.read("subAccounts/sa1"));

const TWILIO = "twilio-secret-0123456789";
const PAGE = "EAA-page-secret";
const GHL = "pit-ghl-secret";

beforeEach(() => {
  mem.clear();
  calls.ghl.length = 0;
  calls.twilioClient.length = 0;
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    name: "Acme",
    metaInboxEnabledByAgency: true,
    socialPlannerEnabledByAgency: false,
  });
  process.env.META_APP_ID = "app";
  process.env.META_APP_SECRET = "secret";
});

describe("connect routes keep the secret off the member-readable doc", () => {
  it("Twilio: token lands in private/, parent keeps status only", async () => {
    const res = await twilioRoute.POST(
      post({ accountSid: "AC123", authToken: TWILIO, fromNumber: "+15550001111" }),
      params,
    );
    expect(res.status).toBe(200);
    expect(memberVisible()).not.toContain(TWILIO);
    const cfg = mem.read("subAccounts/sa1")!.twilioConfig as Record<string, unknown>;
    expect(cfg).toMatchObject({ enabled: true, accountSid: "AC123", fromNumber: "+15550001111" });
    expect(cfg).not.toHaveProperty("authToken");
    expect(mem.read(subAccountSecretPath("sa1", "twilio"))).toEqual({ authToken: TWILIO });
    expect((await getTwilioForSubAccount("sa1")).authToken).toBe(TWILIO);
  });

  it("Twilio re-save with a blank token keeps a LEGACY token, and moves it private", async () => {
    mem.seed("subAccounts/sa1", {
      agencyId: "ag1",
      twilioConfig: { enabled: true, accountSid: "AC123", authToken: TWILIO, fromNumber: "+15550001111" },
    });
    const res = await twilioRoute.POST(
      post({ accountSid: "AC123", authToken: "", fromNumber: "+15550001111" }),
      params,
    );
    expect(res.status).toBe(200);
    expect(memberVisible()).not.toContain(TWILIO);
    expect(mem.read(subAccountSecretPath("sa1", "twilio"))).toEqual({ authToken: TWILIO });
  });

  it("Meta: page token lands in private/, parent keeps status only", async () => {
    const res = await metaCallback.GET(
      new Request("https://app.test/api/meta/callback?code=c&state=s"),
    );
    expect(res.headers.get("location")).toContain("meta=connected");
    expect(memberVisible()).not.toContain(PAGE);
    expect(mem.read("subAccounts/sa1")!.metaConfig).toMatchObject({ connected: true, pageId: "page1" });
    expect(mem.read(subAccountSecretPath("sa1", "meta"))).toEqual({ pageAccessToken: PAGE });
    const prepared = await prepareMetaSend(
      { subAccountId: "sa1", metaUserId: "psid1" } as never,
      "messenger",
    );
    expect(prepared).toMatchObject({ ok: true, pageAccessToken: PAGE });
  });

  it("GHL: token lands in private/, parent keeps the location id only", async () => {
    const res = await ghlConnect.POST(post({ token: GHL, locationId: "loc1" }), params);
    expect(res.status).toBe(200);
    expect(memberVisible()).not.toContain(GHL);
    expect(mem.read("subAccounts/sa1")!.ghlImportConfig).toMatchObject({ locationId: "loc1" });
    expect(mem.read(subAccountSecretPath("sa1", "ghl"))).toEqual({ token: GHL });

    calls.ghl.length = 0;
    expect((await ghlPreview.GET(new Request("https://app.test/x"), params)).status).toBe(200);
    expect(calls.ghl).toEqual([GHL, GHL]);

    await ghlConnect.DELETE(new Request("https://app.test/x", { method: "DELETE" }), params);
    expect(mem.read(subAccountSecretPath("sa1", "ghl"))).toBeUndefined();
  });
});

describe("readers: private doc first, legacy parent field as the pre-migration fallback", () => {
  const LEGACY = "legacy-value";
  const PRIVATE = "private-value";
  const cases = [
    { kind: "twilio", parent: "twilioConfig", field: "authToken" },
    { kind: "meta", parent: "metaConfig", field: "pageAccessToken" },
    { kind: "ghl", parent: "ghlImportConfig", field: "token" },
  ] as const;

  for (const { kind, parent, field } of cases) {
    const seed = (legacy: boolean, priv: boolean) => {
      const cfg = legacy ? { [field]: LEGACY } : {};
      mem.seed("subAccounts/sa1", { agencyId: "ag1", [parent]: cfg });
      if (priv) mem.seed(subAccountSecretPath("sa1", kind), { [field]: PRIVATE });
      return cfg;
    };
    it(`${kind}: private only`, async () => {
      expect(await readSubAccountSecret("sa1", kind, seed(false, true))).toBe(PRIVATE);
    });
    it(`${kind}: legacy only`, async () => {
      expect(await readSubAccountSecret("sa1", kind, seed(true, false))).toBe(LEGACY);
    });
    it(`${kind}: both — private wins`, async () => {
      expect(await readSubAccountSecret("sa1", kind, seed(true, true))).toBe(PRIVATE);
    });
    it(`${kind}: neither`, async () => {
      expect(await readSubAccountSecret("sa1", kind, seed(false, false))).toBe("");
    });
  }

  // The same three states through real send-path readers, not just the helper.
  const states = [
    { name: "private only", legacy: false, priv: true, want: PRIVATE },
    { name: "legacy only", legacy: true, priv: false, want: LEGACY },
    { name: "both", legacy: true, priv: true, want: PRIVATE },
  ];
  for (const s of states) {
    it(`getTwilioForSubAccount — ${s.name}`, async () => {
      mem.seed("subAccounts/sa1", {
        agencyId: "ag1",
        twilioConfig: {
          enabled: true,
          accountSid: "AC1",
          fromNumber: "+15550001111",
          ...(s.legacy ? { authToken: LEGACY } : {}),
        },
      });
      if (s.priv) mem.seed(subAccountSecretPath("sa1", "twilio"), { authToken: PRIVATE });
      expect((await getTwilioForSubAccount("sa1")).authToken).toBe(s.want);
    });
    it(`prepareMetaSend — ${s.name}`, async () => {
      mem.seed("subAccounts/sa1", {
        agencyId: "ag1",
        metaInboxEnabledByAgency: true,
        metaConfig: { connected: true, pageId: "page1", ...(s.legacy ? { pageAccessToken: LEGACY } : {}) },
      });
      if (s.priv) mem.seed(subAccountSecretPath("sa1", "meta"), { pageAccessToken: PRIVATE });
      const prepared = await prepareMetaSend(
        { subAccountId: "sa1", metaUserId: "psid1" } as never,
        "messenger",
      );
      expect(prepared).toMatchObject({ ok: true, pageAccessToken: s.want });
    });
    it(`GHL preview — ${s.name}`, async () => {
      mem.seed("subAccounts/sa1", {
        agencyId: "ag1",
        ghlImportConfig: { locationId: "loc1", ...(s.legacy ? { token: LEGACY } : {}) },
      });
      if (s.priv) mem.seed(subAccountSecretPath("sa1", "ghl"), { token: PRIVATE });
      expect((await ghlPreview.GET(new Request("https://app.test/x"), params)).status).toBe(200);
      expect(calls.ghl[0]).toBe(s.want);
    });
  }
});
