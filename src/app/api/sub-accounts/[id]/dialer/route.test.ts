import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Dialer provisioning through the real route + real require-tenancy +
 * readSubAccountSecret on an in-memory Firestore. Twilio REST is stubbed at
 * `buildTwilioClient` (the SDK seam the route calls); Firebase Auth's getUser
 * returns the seeded custom claims.
 */

const mem = createMemoryFirestore();
const tw = vi.hoisted(() => ({
  built: [] as Array<[string, string]>,
  appCreate: [] as unknown[],
  appUpdate: [] as Array<[string, unknown]>,
  appRemove: [] as string[],
  keyCreate: [] as unknown[],
  keyRemove: [] as string[],
  failRemove: false,
  claims: {} as Record<string, Record<string, unknown>>,
}));

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({
    getUser: async (uid: string) => ({ customClaims: tw.claims[uid] ?? {} }),
  }),
}));
vi.mock("@/lib/comms/twilio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/twilio")>()),
  buildTwilioClient: (sid: string, token: string) => {
    tw.built.push([sid, token]);
    const remove = (list: string[], id: string) => async () => {
      list.push(id);
      if (tw.failRemove) throw new Error("twilio down");
    };
    return {
      applications: Object.assign(
        (id: string) => ({
          update: async (b: unknown) => void tw.appUpdate.push([id, b]),
          remove: remove(tw.appRemove, id),
        }),
        { create: async (b: unknown) => (tw.appCreate.push(b), { sid: `AP${tw.appCreate.length}` }) },
      ),
      newKeys: {
        create: async (b: unknown) => (
          tw.keyCreate.push(b),
          { sid: `SK${tw.keyCreate.length}`, secret: `secret${tw.keyCreate.length}` }
        ),
      },
      keys: (id: string) => ({ remove: remove(tw.keyRemove, id) }),
    };
  },
}));

const route = await import("./route");

type Method = "POST" | "PATCH" | "DELETE";
function req(method: Method, uid: string | null, body?: unknown, sa = "sa1") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (uid) headers["x-user-uid"] = uid;
  return route[method](
    new Request(`https://crm.example.test/api/sub-accounts/${sa}/dialer`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id: sa }) },
  );
}

function seed(over: Record<string, unknown> = {}) {
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    dialerEnabledByAgency: true,
    twilioConfig: { enabled: true, accountSid: "AC_sa1", authToken: "tok_legacy", authTokenSet: true, fromNumber: "+15017122661" },
    ...over,
  });
  mem.seed("subAccounts/sa1/private/twilioCredentials", { authToken: "tok_private" });
}

const sub = () => mem.read("subAccounts/sa1") ?? {};
const priv = () => mem.read("subAccounts/sa1/private/dialer");

beforeEach(() => {
  mem.clear();
  for (const k of Object.keys(tw)) {
    const v = tw[k as keyof typeof tw];
    if (Array.isArray(v)) v.length = 0;
  }
  tw.failRemove = false;
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.test");
  tw.claims = {
    admin: { status: "active", agencyId: "ag1", agencyRole: "staff" },
    collab: { status: "active", agencyId: "ag1", agencyRole: "staff" },
    other: { status: "active", agencyId: "ag2", agencyRole: "staff" },
  };
  mem.seed("subAccounts/sa1/subAccountMembers/admin", { role: "admin", status: "active" });
  mem.seed("subAccounts/sa1/subAccountMembers/collab", { role: "collaborator", status: "active" });
  mem.seed("subAccounts/sa2", { agencyId: "ag2" });
  mem.seed("subAccounts/sa2/subAccountMembers/other", { role: "admin", status: "active" });
  seed();
});

describe("dialer provisioning — gate", () => {
  it("POST and PATCH are 403 gate_off while the gate is off, with no Twilio call", async () => {
    for (const over of [{ dialerEnabledByAgency: false }, { dialerEnabledByAgency: undefined }]) {
      seed({ ...over, dialerConfig: { enabled: true, recordCalls: false } });
      const post = await req("POST", "admin");
      expect(post.status).toBe(403);
      expect(await post.json()).toMatchObject({ code: "gate_off" });
      const patch = await req("PATCH", "admin", { recordCalls: true });
      expect(patch.status).toBe(403);
      expect(await patch.json()).toMatchObject({ code: "gate_off" });
    }
    expect(tw.built).toEqual([]);
    expect(priv()).toBeUndefined();
    expect(sub().dialerConfig).toEqual({ enabled: true, recordCalls: false });
  });

  it("DELETE stays ungated: tears down the remote key + app after the gate is off", async () => {
    await req("POST", "admin");
    seed({ dialerEnabledByAgency: false, dialerConfig: { enabled: true, recordCalls: false } });
    const res = await req("DELETE", "admin");
    expect(res.status).toBe(200);
    expect(tw.appRemove).toEqual(["AP1"]);
    expect(tw.keyRemove).toEqual(["SK1"]);
    expect(priv()).toBeUndefined();
    expect(sub().dialerConfig).toBeNull();
  });
});

describe("dialer provisioning — POST", () => {
  it("creates one key + app on the client's account using the private-doc token", async () => {
    const res = await req("POST", "admin");
    expect(res.status).toBe(200);
    expect(tw.built).toEqual([["AC_sa1", "tok_private"]]);
    expect(tw.appCreate).toEqual([
      expect.objectContaining({
        voiceUrl: "https://crm.example.test/api/webhooks/twilio/dialer/twiml/sa1",
        voiceMethod: "POST",
      }),
    ]);
    expect(priv()).toMatchObject({ apiKeySid: "SK1", apiKeySecret: "secret1", twimlAppSid: "AP1" });
    expect(sub().dialerConfig).toEqual({ enabled: true, recordCalls: false });
    expect(JSON.stringify(sub())).not.toContain("secret1");
  });

  it("is idempotent: a second POST refreshes the voice URL and mints nothing new", async () => {
    await req("POST", "admin");
    await req("PATCH", "admin", { recordCalls: true });
    const res = await req("POST", "admin");
    expect(res.status).toBe(200);
    expect(tw.appCreate).toHaveLength(1);
    expect(tw.keyCreate).toHaveLength(1);
    expect(tw.appUpdate).toEqual([["AP1", expect.objectContaining({ voiceMethod: "POST" })]]);
    expect(priv()).toMatchObject({ apiKeySid: "SK1", twimlAppSid: "AP1" });
    expect(sub().dialerConfig).toEqual({ enabled: true, recordCalls: true });
  });

  it("refuses without a dedicated Twilio token (400)", async () => {
    mem.clear();
    mem.seed("subAccounts/sa1/subAccountMembers/admin", { role: "admin", status: "active" });
    mem.seed("subAccounts/sa1", {
      agencyId: "ag1",
      dialerEnabledByAgency: true,
      twilioConfig: { enabled: true, accountSid: "AC_sa1", authTokenSet: true, fromNumber: "+15017122661" },
    });
    expect((await req("POST", "admin")).status).toBe(400);
    expect(tw.built).toEqual([]);
  });

  it("only a sub-account admin of THIS sub-account may provision", async () => {
    expect((await req("POST", null)).status).toBe(401);
    expect((await req("POST", "collab")).status).toBe(403);
    expect((await req("POST", "other")).status).toBe(403);
    expect((await req("DELETE", "collab")).status).toBe(403);
    expect(tw.built).toEqual([]);
  });
});

describe("dialer provisioning — PATCH / DELETE", () => {
  it("PATCH needs a boolean and an enabled dialer; recording defaults off", async () => {
    expect((await req("PATCH", "admin", { recordCalls: true })).status).toBe(400);
    await req("POST", "admin");
    expect(sub().dialerConfig).toEqual({ enabled: true, recordCalls: false });
    expect((await req("PATCH", "admin", { recordCalls: "yes" })).status).toBe(400);
    expect((await req("PATCH", "admin", { recordCalls: true })).status).toBe(200);
    expect(sub().dialerConfig).toEqual({ enabled: true, recordCalls: true });
  });

  it("DELETE succeeds and clears local state when Twilio refuses the remote removes", async () => {
    await req("POST", "admin");
    tw.failRemove = true;
    expect((await req("DELETE", "admin")).status).toBe(200);
    expect(tw.appRemove).toEqual(["AP1"]);
    expect(tw.keyRemove).toEqual(["SK1"]);
    expect(priv()).toBeUndefined();
    expect(sub().dialerConfig).toBeNull();
  });
});
