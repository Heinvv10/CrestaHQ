import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-handler tests for the self-serve wa-manager seam.
 *
 * `@/lib/auth/require-tenancy` is deliberately NOT mocked, for the same reason
 * the manual connect route's tests don't mock it: the tenancy refusal is the
 * assertion that matters most here, and a mocked guard proves only that the
 * route calls something. Firestore and Firebase Auth are faked underneath it,
 * so the real membership lookup runs against real fake documents.
 *
 * The manager is faked at the FETCH boundary rather than by mocking
 * `manager-client`. The single most important property of this seam is which
 * tenant id reaches the manager, and that is a URL — a mocked client would let
 * the routes pass a caller-supplied id straight through with every test still
 * green.
 */

const SUB = "sa_1";
const OTHER_SUB = "sa_2";
const APP_TOKEN = "app-token-from-the-manager";
const HOOK_SECRET = "hook-secret-from-the-manager";
const PAIR_CODE = "2@abcdef-pairing-code";
/** The sub-account id of an unrelated workspace, as it appears in the
 *  manager's collision sentence. It must never reach a response body: it is
 *  another customer's identity. */
const COLLIDING_SUB = "sa_someone_elses_workspace";

const SECRET_PATH = `subAccounts/${SUB}/private/whatsappBridge`;
const ACKS_PATH = `subAccounts/${SUB}/whatsappBridgeRiskAcks`;
const OTHER_ACKS_PATH = `subAccounts/${OTHER_SUB}/whatsappBridgeRiskAcks`;
/** Must equal WA_BRIDGE_RISK_TEXT_ID. Spelled out rather than imported so a
 *  silent rename of the constant shows up here as a failure rather than as a
 *  test that quietly follows the code wherever it goes. */
const RISK_TEXT_ID = "wa-bridge-risk-v1";
/** The fake manager's QR bytes. Deliberately do NOT contain PAIR_CODE: a qr
 *  route that answered with the pairing string instead of the image would then
 *  fail the "no code as text" assertion. */
const QR_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MANAGER_URL = "http://127.0.0.1:33000";
const OPERATOR_TOKEN = "operator-token-that-opens-every-tenant";

interface Write {
  op: "set" | "delete" | "add";
  path: string;
  data?: Record<string, unknown>;
  opts?: unknown;
}

let docs: Map<string, Record<string, unknown>>;
/** Subcollection contents, keyed by collection path. Only the risk-ack log
 *  uses this today; the routes read it through a real where()/limit()/get(). */
let collections: Map<string, Record<string, unknown>[]>;
let writes: Write[];
let claims: Map<string, Record<string, unknown>>;
let calls: { url: string; init: RequestInit }[];
/** Set to make every batch commit throw, standing in for a Firestore that is
 *  unreachable at the exact moment the minted credentials must be persisted. */
let failCommit: boolean;

function docRef(path: string) {
  return {
    __path: path,
    get: async () => ({
      exists: docs.has(path),
      data: () => docs.get(path),
      id: path.split("/").pop(),
    }),
    set: async (data: Record<string, unknown>, opts?: unknown) => {
      writes.push({ op: "set", path, data, opts });
    },
    delete: async () => {
      writes.push({ op: "delete", path });
    },
  };
}

function collectionRef(path: string) {
  const rows = () => collections.get(path) ?? [];
  return {
    add: async (data: Record<string, unknown>) => {
      writes.push({ op: "add", path, data });
      collections.set(path, [...rows(), data]);
    },
    // Only the shape the ack gate uses: one equality filter, then a limit.
    where: (field: string, op: string, value: unknown) => ({
      limit: (n: number) => ({
        get: async () => {
          if (op !== "==") throw new Error(`unsupported operator ${op}`);
          const hits = rows()
            .filter((r) => r[field] === value)
            .slice(0, n);
          return { empty: hits.length === 0, docs: hits };
        },
      }),
    }),
  };
}

const fakeDb = {
  doc: docRef,
  collection: collectionRef,
  batch: () => {
    const staged: Write[] = [];
    return {
      set: (
        ref: { __path: string },
        data: Record<string, unknown>,
        opts?: unknown,
      ) => {
        staged.push({ op: "set", path: ref.__path, data, opts });
      },
      commit: async () => {
        if (failCommit) throw new Error("firestore: unavailable");
        writes.push(...staged);
      },
    };
  },
};

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => fakeDb,
  getAdminAuth: () => ({
    getUser: async (uid: string) => ({ customClaims: claims.get(uid) ?? {} }),
  }),
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));

import { POST as PROVISION } from "./provision/route";
import { GET as PAIRING } from "./pairing/route";
import { POST as RESTART } from "./restart/route";
import { DELETE as DISCONNECT } from "./route";
import { GET as QR } from "./qr/route";
import { POST as RISK_ACK } from "./risk-ack/route";

type Handler = typeof PROVISION | typeof PAIRING;

/** A manager that answers every route with a plausible body. */
function stubManager(
  responder: (url: string, init: RequestInit) => Response = defaultResponder,
) {
  const spy = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return responder(url, init);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function defaultResponder(url: string, init: RequestInit): Response {
  if (init.method === "POST" && url.endsWith("/api/tenants")) {
    return json(
      {
        tenantId: SUB,
        displayName: "Blitz Fibre",
        instance: "sa-1",
        port: 33101,
        state: "provisioned",
        health: null,
        token: APP_TOKEN,
        webhookSecret: HOOK_SECRET,
      },
      201,
    );
  }
  if (url.includes("/qr.png")) {
    return new Response(QR_PNG, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }
  if (url.includes("/pair")) {
    return json({
      tenantId: SUB,
      pairing: true,
      connected: false,
      code: PAIR_CODE,
      expiresAt: "2026-09-07T10:00:00Z",
    });
  }
  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function call(
  handler: Handler,
  method: string,
  path: string,
  opts: { uid?: string; id?: string; body?: Record<string, unknown> } = {},
) {
  const id = opts.id ?? SUB;
  // The hostile-input payload rides as a query string on GET (which cannot
  // carry a body) and as a JSON body otherwise, so every route is probed with
  // an attacker-supplied tenant id in the place that route would read one.
  const query =
    method === "GET" && opts.body
      ? `?${new URLSearchParams(
          Object.entries(opts.body).map(([k, v]) => [k, String(v)]),
        )}`
      : "";
  return handler(
    new Request(
      `http://app.local/api/sub-accounts/${id}/whatsapp-bridge${path}${query}`,
      {
        method,
        headers: {
          "content-type": "application/json",
          "x-user-uid": opts.uid ?? "uid_admin",
        },
        ...(method !== "GET" && opts.body
          ? { body: JSON.stringify(opts.body) }
          : {}),
      },
    ),
    { params: Promise.resolve({ id }) },
  );
}

const provision = (o?: Parameters<typeof call>[3]) =>
  call(PROVISION as Handler, "POST", "/provision", o);
const pairing = (o?: Parameters<typeof call>[3]) =>
  call(PAIRING as Handler, "GET", "/pairing", o);
const restart = (o?: Parameters<typeof call>[3]) =>
  call(RESTART as unknown as Handler, "POST", "/restart", o);
const disconnect = (o?: Parameters<typeof call>[3]) =>
  call(DISCONNECT as unknown as Handler, "DELETE", "", o);
const qr = (o?: Parameters<typeof call>[3]) =>
  call(QR as Handler, "GET", "/qr", o);
const riskAck = (o?: Parameters<typeof call>[3]) =>
  call(RISK_ACK as unknown as Handler, "POST", "/risk-ack", o);

async function read(res: Response) {
  // Read as text first: the QR route answers with PNG bytes, and a helper that
  // insisted on JSON could not probe it at all.
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, body, raw, headers: res.headers };
}

beforeEach(() => {
  writes = [];
  calls = [];
  failCommit = false;
  // Both workspaces have already accepted the CURRENT warning, so the
  // provisioning tests exercise the happy path. The ack tests below empty this
  // deliberately.
  collections = new Map<string, Record<string, unknown>[]>([
    [ACKS_PATH, [{ uid: "uid_admin", textId: RISK_TEXT_ID, text: "…" }]],
    [
      OTHER_ACKS_PATH,
      [{ uid: "uid_other_admin", textId: RISK_TEXT_ID, text: "…" }],
    ],
  ]);
  vi.stubEnv("WA_MANAGER_BASE_URL", MANAGER_URL);
  vi.stubEnv("WA_MANAGER_OPERATOR_TOKEN", OPERATOR_TOKEN);
  docs = new Map<string, Record<string, unknown>>([
    [
      `subAccounts/${SUB}`,
      { agencyId: "ag_1", name: "Blitz Fibre", whatsappEnabledByAgency: true },
    ],
    [
      `subAccounts/${OTHER_SUB}`,
      { agencyId: "ag_1", name: "Other Co", whatsappEnabledByAgency: true },
    ],
    [
      `subAccounts/${SUB}/subAccountMembers/uid_admin`,
      { status: "active", subAccountRole: "admin", role: "admin" },
    ],
    [
      `subAccounts/${SUB}/subAccountMembers/uid_member`,
      { status: "active", subAccountRole: "user", role: "user" },
    ],
    [
      `subAccounts/${OTHER_SUB}/subAccountMembers/uid_other_admin`,
      { status: "active", subAccountRole: "admin", role: "admin" },
    ],
  ]);
  claims = new Map<string, Record<string, unknown>>([
    ["uid_admin", { status: "active", agencyId: "ag_1", agencyRole: null }],
    ["uid_member", { status: "active", agencyId: "ag_1", agencyRole: null }],
    [
      "uid_other_admin",
      { status: "active", agencyId: "ag_1", agencyRole: null },
    ],
  ]);
  stubManager();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ROUTES: Array<[string, () => Promise<Response>]> = [
  ["provision", () => provision()],
  ["pairing", () => pairing()],
  ["restart", () => restart()],
  ["disconnect", () => disconnect()],
  ["qr", () => qr()],
];

describe("tenancy", () => {
  for (const [name, _fire] of ROUTES) {
    it(`${name} refuses a non-admin member and never reaches the manager`, async () => {
      const res = await runAs(name, "uid_member", SUB);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Sub-account admin only");
      expect(calls).toEqual([]);
      expect(writes).toEqual([]);
    });

    it(`${name} refuses an admin of a DIFFERENT sub-account`, async () => {
      // The tenancy case. uid_other_admin is a genuine admin — of sa_2 — so a
      // route that checked "is an admin somewhere" would provision, pair or
      // destroy another customer's WhatsApp number.
      const res = await runAs(name, "uid_other_admin", SUB);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Not a member");
      expect(calls).toEqual([]);
      expect(writes).toEqual([]);
    });
  }

  /**
   * THE property this seam exists to hold. wa-manager has one global operator
   * token and no notion of tenant ownership, so whichever id reaches its URL
   * is the tenant that gets provisioned, paired, bounced or erased.
   *
   * uid_other_admin is an admin of sa_2 and calls sa_2's own route while
   * asking, in the body and the query, for sa_1. Every manager URL must name
   * sa_2 — the session's sub-account — and sa_1 must appear nowhere.
   */
  for (const [name] of ROUTES) {
    it(`${name} calls the manager with the SESSION's sub-account, not the one the request names`, async () => {
      const res = await runAs(name, "uid_other_admin", OTHER_SUB, {
        tenantId: SUB,
        subAccountId: SUB,
        id: SUB,
      });
      expect(res.status).toBeLessThan(400);
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        // The id travels in the URL for pair/restart/delete and in the body
        // for provision, so both halves are checked together.
        const sent = `${c.url} ${String(c.init.body ?? "")}`;
        expect(sent).toContain(OTHER_SUB);
        expect(sent).not.toContain(SUB);
      }
    });
  }
});

/** Fire one route as `uid` against `id`, optionally with a hostile body. */
async function runAs(
  name: string,
  uid: string,
  id: string,
  body?: Record<string, unknown>,
) {
  const opts = { uid, id, body };
  switch (name) {
    case "provision":
      return read(await provision(opts));
    case "pairing":
      return read(await pairing(opts));
    case "restart":
      return read(await restart(opts));
    case "qr":
      return read(await qr(opts));
    case "risk-ack":
      return read(await riskAck(opts));
    default:
      return read(await disconnect(opts));
  }
}

describe("provision", () => {
  it("stores the minted credentials at the private path and puts no secret on the sub-account doc", async () => {
    const { status, body } = await read(await provision());
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, provider: "bridge", state: "provisioned" });

    const secret = writes.find((w) => w.path === SECRET_PATH);
    expect(secret?.data).toEqual({
      baseUrl: "http://127.0.0.1:33101",
      token: APP_TOKEN,
      webhookSecret: HOOK_SECRET,
    });

    const doc = writes.find((w) => w.path === `subAccounts/${SUB}`);
    expect(doc?.data?.whatsappProvider).toBe("bridge");
    expect(JSON.stringify(doc?.data)).not.toContain(APP_TOKEN);
    expect(JSON.stringify(doc?.data)).not.toContain(HOOK_SECRET);
    // Nothing is paired yet — the number is unknown until a code is scanned.
    expect(
      (doc?.data?.whatsappBridgeMeta as { displayPhoneNumber: unknown })
        .displayPhoneNumber,
    ).toBeNull();
  });

  it("never returns a credential to the browser", async () => {
    const res = await provision();
    const raw = await res.text();
    expect(raw).not.toContain(APP_TOKEN);
    expect(raw).not.toContain(HOOK_SECRET);
    expect(raw).not.toContain(OPERATOR_TOKEN);
  });

  it("refuses when the agency has WhatsApp switched off, before reaching the manager", async () => {
    docs.set(`subAccounts/${SUB}`, { agencyId: "ag_1", name: "Blitz" });
    const { status } = await read(await provision());
    expect(status).toBe(403);
    expect(calls).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("refuses a tenant the manager provisioned UNSIGNED, and stores nothing", async () => {
    // No webhookSecret in the 201: the manager has no secret generator, so
    // inbound would be unverifiable. Storing that would give the workspace a
    // rail that accepts anything reaching its webhook URL.
    stubManager((url, init) =>
      init.method === "POST" && url.endsWith("/api/tenants")
        ? json(
            {
              tenantId: SUB,
              displayName: "Blitz",
              instance: "sa-1",
              port: 33101,
              state: "provisioned",
              health: null,
              token: APP_TOKEN,
            },
            201,
          )
        : json({ ok: true }),
    );
    const { status, body } = await read(await provision());
    expect(status).toBe(502);
    expect(body.error).toContain("webhook signing secret");
    expect(writes).toEqual([]);
  });

  it("tells a workspace that DOES hold credentials to disconnect first, and stores nothing", async () => {
    // The secret doc is there, so this workspace genuinely has a bridge and
    // the remedy is one it can perform.
    docs.set(SECRET_PATH, {
      baseUrl: "http://127.0.0.1:33101",
      token: APP_TOKEN,
      webhookSecret: HOOK_SECRET,
    });
    stubManager(() =>
      json({ error: `tenant "sa_1" already exists; destroy it first` }, 409),
    );
    const { status, body } = await read(await provision());
    expect(status).toBe(409);
    expect(String(body.error)).toContain("Disconnect it first");
    expect(writes).toEqual([]);
  });

  it("answers a name collision without naming the other workspace", async () => {
    // The manager's own sentence names the tenant holding the instance name —
    // another customer's sub-account id. This workspace holds no credentials,
    // so the 409 cannot be its own bridge; the admin is told what happened and
    // given no remedy, because they have none. Asserted on the SERIALISED body
    // rather than one field, the way the pairing-code test is: a foreign id
    // added to any other key would be the same disclosure.
    stubManager(() =>
      json(
        {
          error: `tenant "sa_1" would take instance "sa-1", already held by tenant "${COLLIDING_SUB}"`,
        },
        409,
      ),
    );
    const { status, body, raw } = await read(await provision());
    expect(status).toBe(409);
    expect(String(body.error)).toContain("collides with another workspace");
    expect(String(body.error)).not.toContain("Disconnect it first");
    expect(raw).not.toContain(COLLIDING_SUB);
    expect(writes).toEqual([]);
  });

  it("says the credentials are lost when the store write fails after the manager 201'd", async () => {
    // The 201 is the only moment these values exist outside the bridge's .env
    // — no rotation route, no readable copy. A bare 500 leaves an operator
    // retrying a provision that will now 409 forever, so the response has to
    // name the remedy.
    failCommit = true;
    const { status, body } = await read(await provision());
    expect(status).toBe(500);
    expect(String(body.error)).toContain("can't be recovered");
    expect(String(body.error)).toContain("Disconnect");
    // No automatic cleanup: a destroy on a failure path is how a bridge
    // someone is mid-way through pairing gets deleted.
    expect(calls.some((c) => c.init.method === "DELETE")).toBe(false);
  });
});

/**
 * The agency feature gate. `whatsappEnabledByAgency` is the agency's switch for
 * this workspace, and a gate that only stopped NEW bridges would leave every
 * existing one fully operable: a switched-off workspace's admin could still
 * pull a live pairing credential and bounce the bridge to mint fresh ones.
 */
describe("agency feature gate", () => {
  const GATED: Array<[string, string]> = [
    ["provision", "creates a bridge"],
    ["pairing", "hands out live pairing state"],
    ["restart", "mints a fresh batch of pairing codes"],
    ["qr", "hands out the pairing credential as an image"],
  ];

  for (const [name, why] of GATED) {
    it(`${name} is refused when the agency switched WhatsApp off (it ${why}), and never reaches the manager`, async () => {
      docs.set(`subAccounts/${SUB}`, { agencyId: "ag_1", name: "Blitz" });
      const res = await runAs(name, "uid_admin", SUB);
      expect(res.status).toBe(403);
      expect(String(res.body.error)).toContain("isn't enabled for this workspace");
      expect(calls).toEqual([]);
      expect(writes).toEqual([]);
    });

    it(`${name} proceeds when the agency has WhatsApp on`, async () => {
      // The other direction. A gate asserted only in its refusing state passes
      // just as well when it refuses everything.
      const res = await runAs(name, "uid_admin", SUB);
      expect(res.status).toBeLessThan(400);
      expect(calls.length).toBeGreaterThan(0);
    });
  }

  it("disconnect still works with the gate off — the off-switch is never gated", async () => {
    // Deliberate carve-out. A workspace whose gate was just switched off is
    // precisely the one that may need to tear its bridge down; gating the
    // disconnect would strand it with a running bridge nothing can address.
    docs.set(`subAccounts/${SUB}`, { agencyId: "ag_1", name: "Blitz" });
    const { status, body } = await read(await disconnect());
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, provider: "twilio" });
    expect(calls.some((c) => c.init.method === "DELETE")).toBe(true);
    expect(writes.map((w) => w.op)).toEqual(["set", "delete"]);
  });
});

describe("risk acknowledgement", () => {
  /**
   * THE test of this slice. The bridge rail is an unofficial WhatsApp
   * connection and the number can be banned, so the acknowledgement is a
   * condition of provisioning rather than a checkbox. A client-side-only check
   * refuses nothing: this endpoint is one authenticated `curl` away.
   */
  it("provision is REFUSED without a recorded acknowledgement, before the manager is touched", async () => {
    collections.set(ACKS_PATH, []);
    const { status, body } = await read(await provision());
    expect(status).toBe(403);
    expect(String(body.error)).toContain("risks");
    expect(calls).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("provision is refused when the only acknowledgement is of an OLDER warning", async () => {
    // Bumping the id after a material change to the wording re-asks everyone:
    // somebody who agreed to different words has not agreed to these.
    collections.set(ACKS_PATH, [
      { uid: "uid_admin", textId: "wa-bridge-risk-v0", text: "older words" },
    ]);
    const { status } = await read(await provision());
    expect(status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("provision is ACCEPTED once the current warning is acknowledged", async () => {
    collections.set(ACKS_PATH, []);
    expect((await read(await provision())).status).toBe(403);

    const ack = await read(await riskAck());
    expect(ack.status).toBe(200);
    expect(ack.body.textId).toBe(RISK_TEXT_ID);

    calls = [];
    const { status } = await read(await provision());
    expect(status).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("records who agreed, when, which version and the exact words shown", async () => {
    collections.set(ACKS_PATH, []);
    await riskAck();
    const added = writes.filter((w) => w.op === "add");
    expect(added).toHaveLength(1);
    expect(added[0].path).toBe(ACKS_PATH);
    const rec = added[0].data as Record<string, unknown>;
    // The uid comes from the SESSION. An audit record whose subject the client
    // chose records nothing.
    expect(rec.uid).toBe("uid_admin");
    // The server's clock, never the browser's.
    expect(rec.acknowledgedAt).toBe("SERVER_TS");
    expect(rec.textId).toBe(RISK_TEXT_ID);
    // The full text, copied in, so the record stays readable after the
    // constant is edited or deleted.
    expect(String(rec.text)).toContain("ban");
    expect(String(rec.text).length).toBeGreaterThan(200);
  });

  it("is admin-only and refuses an admin of a DIFFERENT sub-account", async () => {
    for (const uid of ["uid_member", "uid_other_admin"]) {
      writes = [];
      const res = await read(await riskAck({ uid, id: SUB }));
      expect(res.status).toBe(403);
      expect(writes).toEqual([]);
    }
  });

  it("writes under the SESSION's sub-account, not the one the request names", async () => {
    await riskAck({
      uid: "uid_other_admin",
      id: OTHER_SUB,
      body: { subAccountId: SUB, uid: "uid_admin" },
    });
    const added = writes.filter((w) => w.op === "add");
    expect(added.map((w) => w.path)).toEqual([OTHER_ACKS_PATH]);
    expect(added[0].data?.uid).toBe("uid_other_admin");
  });

  it("survives a disconnect — the record is not deleted with the rail", async () => {
    // The audit record covers the period the number WAS connected, which is
    // the only period anyone would ever ask about.
    await disconnect();
    expect(writes.some((w) => w.path.includes("whatsappBridgeRiskAcks"))).toBe(
      false,
    );
    expect(collections.get(ACKS_PATH)).toHaveLength(1);
  });
});

describe("qr image", () => {
  it("answers with the manager's PNG and never the code as text", async () => {
    const res = await qr();
    const { status, raw, headers } = await read(res);
    expect(status).toBe(200);
    expect(headers.get("content-type")).toBe("image/png");
    // A route that answered by relaying ../pair's JSON would put the
    // write-grade payload in a body the browser can read as a string.
    expect(raw).not.toContain(PAIR_CODE);
    expect(raw).not.toContain(OPERATOR_TOKEN);
  });

  it("never lets the code be cached, on success or on failure", async () => {
    // An <img> response is exactly what a disk cache or a proxy keeps, and a
    // cached QR is a credential surviving its own expiry.
    expect((await qr()).headers.get("cache-control")).toBe("no-store");

    stubManager(() => new Response("not waiting to pair", { status: 409 }));
    const failed = await qr();
    expect(failed.status).toBe(409);
    expect(failed.headers.get("cache-control")).toBe("no-store");
  });

  it("asks the manager for the SESSION's tenant", async () => {
    await qr({ uid: "uid_other_admin", id: OTHER_SUB, body: { id: SUB } });
    expect(calls.map((c) => c.url)).toEqual([
      `${MANAGER_URL}/tenants/${OTHER_SUB}/qr.png`,
    ]);
  });
});

describe("pairing", () => {
  it("answers the question the screen asks, and NEVER the pairing code", async () => {
    // The code is a write-grade credential. It reaches the admin as pixels
    // from ../qr and in no other form, so it must not appear here — not as a
    // field, and not anywhere in the serialised body.
    const res = await pairing();
    const { status, body, raw } = await read(res);
    expect(status).toBe(200);
    expect(body).toEqual({
      pairing: true,
      connected: false,
      expiresAt: "2026-09-07T10:00:00Z",
    });
    expect("code" in body).toBe(false);
    expect(raw).not.toContain(PAIR_CODE);
  });

  it("omits expiresAt entirely when no round is in flight", async () => {
    // ABSENT, not "". "" parses as the epoch and a caller cannot tell a blank
    // timestamp from a missing one.
    stubManager(() => json({ tenantId: SUB, pairing: false, connected: true }));
    const { status, body } = await read(await pairing());
    expect(status).toBe(200);
    expect(body).toEqual({ pairing: false, connected: true });
    expect("expiresAt" in body).toBe(false);
  });
});

describe("disconnect", () => {
  it("sends the manager's required confirm parameter", async () => {
    // wa-manager refuses a delete without ?confirm=<same id>, because the
    // operator token proves who is calling and not that they meant THIS
    // tenant. Dropping it turns disconnect into a silent 400.
    await disconnect();
    const del = calls.find((c) => c.init.method === "DELETE");
    expect(del?.url).toBe(
      `${MANAGER_URL}/api/tenants/${SUB}?confirm=${SUB}`,
    );
  });

  it("clears the rail and the stored credentials", async () => {
    const { status, body } = await read(await disconnect());
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, provider: "twilio" });
    expect(writes).toEqual([
      {
        op: "set",
        path: `subAccounts/${SUB}`,
        data: {
          whatsappProvider: "twilio",
          whatsappBridgeMeta: null,
          updatedAt: "SERVER_TS",
        },
        opts: { merge: true },
      },
      { op: "delete", path: SECRET_PATH },
    ]);
  });

  it("keeps the credentials when the manager refuses the destroy", async () => {
    // Clearing the rail first would delete the only copy of the credentials
    // this deployment has — no manager route reads a stored token back —
    // leaving a live bridge nothing can address or tear down.
    stubManager(() => json({ error: "could not tear this tenant down" }, 500));
    const { status } = await read(await disconnect());
    expect(status).toBe(502);
    expect(writes).toEqual([]);
  });

  it("still clears the rail when the manager has no such tenant", async () => {
    stubManager(() => json({ error: "no such tenant" }, 404));
    const { status } = await read(await disconnect());
    expect(status).toBe(200);
    expect(writes.map((w) => w.op)).toEqual(["set", "delete"]);
  });
});

describe("no manager configured", () => {
  // A buyer copy on Vercel and a dev machine have no manager. Every route must
  // say so rather than throwing, 500ing, or — worst — appearing to succeed.
  for (const missing of [
    "WA_MANAGER_BASE_URL",
    "WA_MANAGER_OPERATOR_TOKEN",
  ] as const) {
    for (const [name] of ROUTES) {
      it(`${name} answers 503 when ${missing} is absent`, async () => {
        vi.stubEnv(missing, "");
        const res = await runAs(name, "uid_admin", SUB);
        expect(res.status).toBe(503);
        expect(res.body.error).toContain("isn't configured");
        expect(calls).toEqual([]);
        expect(writes).toEqual([]);
      });
    }
  }

  it("treats a blank-but-present token as absent", async () => {
    // Env files carry trailing newlines and stray spaces; a whitespace token
    // presented as a bearer produces a 401 that reads like a revocation.
    vi.stubEnv("WA_MANAGER_OPERATOR_TOKEN", "   \n");
    const res = await runAs("restart", "uid_admin", SUB);
    expect(res.status).toBe(503);
    expect(calls).toEqual([]);
  });
});
