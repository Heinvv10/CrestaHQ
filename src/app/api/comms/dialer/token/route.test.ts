import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Dialer token minting through the real route + real require-tenancy on an
 * in-memory Firestore; Firebase Auth's getUser returns seeded claims. The
 * JWT is minted by the real twilio SDK and decoded here.
 */

const mem = createMemoryFirestore();
const claims = vi.hoisted(() => ({}) as Record<string, Record<string, unknown>>);
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({
    getUser: async (uid: string) => ({ customClaims: claims[uid] ?? {} }),
  }),
}));

const { POST } = await import("./route");

function mint(uid: string | null, subAccountId: unknown = "sa1") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (uid) headers["x-user-uid"] = uid;
  return POST(
    new Request("https://crm.example.test/api/comms/dialer/token", {
      method: "POST",
      headers,
      body: JSON.stringify({ subAccountId }),
    }),
  );
}

function seed(over: Record<string, unknown> = {}) {
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    dialerEnabledByAgency: true,
    dialerConfig: { enabled: true, recordCalls: false },
    twilioConfig: { enabled: true, accountSid: "AC_sa1", authTokenSet: true, fromNumber: "+15017122661" },
    ...over,
  });
}

function payload(jwt: string) {
  return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"));
}

beforeEach(() => {
  mem.clear();
  for (const k of Object.keys(claims)) delete claims[k];
  claims.collab = { status: "active", agencyId: "ag1", agencyRole: "staff" };
  claims.owner = { status: "active", agencyId: "ag1", agencyRole: "owner" };
  claims.removed = { status: "active", agencyId: "ag1", agencyRole: "staff" };
  claims.other = { status: "active", agencyId: "ag2", agencyRole: "staff" };
  claims.otherOwner = { status: "active", agencyId: "ag2", agencyRole: "owner" };
  seed();
  mem.seed("subAccounts/sa1/private/dialer", {
    apiKeySid: "SK_sa1",
    apiKeySecret: "key_secret",
    twimlAppSid: "AP_sa1",
  });
  mem.seed("subAccounts/sa1/subAccountMembers/collab", { role: "collaborator", status: "active" });
  mem.seed("subAccounts/sa1/subAccountMembers/removed", { role: "collaborator", status: "removed" });
  mem.seed("subAccounts/sa2", { agencyId: "ag2" });
  mem.seed("subAccounts/sa2/subAccountMembers/other", { role: "admin", status: "active" });
});

describe("dialer token", () => {
  it("any active member gets an outbound-only token scoped to the TwiML App, identity = uid", async () => {
    const res = await mint("collab");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, ttlSeconds: 3600 });
    const p = payload(body.token);
    expect(p.iss).toBe("SK_sa1");
    expect(p.sub).toBe("AC_sa1");
    expect(p.grants.identity).toBe("collab");
    expect(p.grants.voice.outgoing.application_sid).toBe("AP_sa1");
    expect(p.grants.voice.incoming?.allow).not.toBe(true);
    expect(JSON.stringify(body)).not.toContain("key_secret");
  });

  it("the agency owner of the parent agency may mint", async () => {
    expect((await mint("owner")).status).toBe(200);
  });

  it("refuses non-members, removed members, other agencies and anonymous callers", async () => {
    expect((await mint(null)).status).toBe(401);
    expect((await mint("removed")).status).toBe(403);
    expect((await mint("other")).status).toBe(403);
    expect((await mint("otherOwner")).status).toBe(403);
  });

  it("gate off is 403 gate_off even for a member with a provisioned dialer", async () => {
    for (const gate of [false, undefined]) {
      seed({ dialerEnabledByAgency: gate });
      const res = await mint("collab");
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "gate_off" });
    }
  });

  it("R6: dedicated Twilio switched off (creds kept) stops new tokens", async () => {
    seed({ twilioConfig: { enabled: false, accountSid: "AC_sa1", authTokenSet: true, fromNumber: "+15017122661" } });
    const res = await mint("collab");
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("token");
    seed();
    expect((await mint("collab")).status).toBe(200);
  });

  it("a disabled dialer is 403; a missing provision is 503; a missing id is 400", async () => {
    seed({ dialerConfig: null });
    expect((await mint("collab")).status).toBe(403);
    seed();
    await mem.db.doc("subAccounts/sa1/private/dialer").delete();
    expect((await mint("collab")).status).toBe(503);
    expect((await mint("collab", "")).status).toBe(400);
  });
});
