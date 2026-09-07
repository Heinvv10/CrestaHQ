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

const SECRET_PATH = `subAccounts/${SUB}/private/whatsappBridge`;
const MANAGER_URL = "http://127.0.0.1:33000";
const OPERATOR_TOKEN = "operator-token-that-opens-every-tenant";

interface Write {
  op: "set" | "delete";
  path: string;
  data?: Record<string, unknown>;
  opts?: unknown;
}

let docs: Map<string, Record<string, unknown>>;
let writes: Write[];
let claims: Map<string, Record<string, unknown>>;
let calls: { url: string; init: RequestInit }[];

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

const fakeDb = {
  doc: docRef,
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

async function read(res: Response) {
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

beforeEach(() => {
  writes = [];
  calls = [];
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

  it("relays a manager 409 as an actionable conflict and stores nothing", async () => {
    stubManager(() => json({ error: "tenant already exists" }, 409));
    const { status, body } = await read(await provision());
    expect(status).toBe(409);
    expect(body.error).toContain("Disconnect it first");
    expect(writes).toEqual([]);
  });
});

describe("pairing", () => {
  it("passes the code through when a round is in flight", async () => {
    const { status, body } = await read(await pairing());
    expect(status).toBe(200);
    expect(body).toEqual({
      pairing: true,
      connected: false,
      code: PAIR_CODE,
      expiresAt: "2026-09-07T10:00:00Z",
    });
  });

  it("omits code and expiresAt entirely when no round is in flight", async () => {
    // ABSENT, not "". A blank code renders as a QR of nothing and a caller
    // cannot tell it from a missing one.
    stubManager(() => json({ tenantId: SUB, pairing: false, connected: true }));
    const { status, body } = await read(await pairing());
    expect(status).toBe(200);
    expect(body).toEqual({ pairing: false, connected: true });
    expect("code" in body).toBe(false);
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
