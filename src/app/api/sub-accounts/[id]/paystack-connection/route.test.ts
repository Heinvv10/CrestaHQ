import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-handler tests for the per-sub-account Paystack connect/disconnect.
 *
 * `@/lib/auth/require-tenancy` is deliberately NOT mocked: the tenancy refusal
 * is the assertion that matters most, and a mocked guard proves only that the
 * route calls something. Firestore and Firebase Auth are faked underneath it,
 * so the real membership lookup runs against real fake documents.
 *
 * The fake records WRITES only — reads go through the same `doc()` and would
 * otherwise drown the one thing every guard test asserts, which is that a
 * refused connect writes nothing at all.
 */

const SUB = "sa_1";
const OTHER_SUB = "sa_2";
// Fixture keys are deliberately tiny, matching the convention already used by
// this repo's Stripe tests (`sk_test_1`, `sk_live_s`). gitleaks reads a longer
// sk_live_/rk_live_ body as a real Stripe key and the secret-scan gate is
// blocking; it cannot tell a fixture from the real thing, and widening its
// allowlist for test data is how a scanner quietly stops scanning. These are
// still valid per PAYSTACK_SECRET_KEY_RE, and short enough that the leak test's
// 8-char sliding window still catches a mutation that publishes the whole key.
const LIVE_KEY = "sk_live_t1";
const TEST_KEY = "sk_test_t2";
const SECRET_PATH = `subAccounts/${SUB}/private/paystackConnection`;

interface Write {
  op: "set" | "delete";
  path: string;
  data?: Record<string, unknown>;
  opts?: unknown;
}

let docs: Map<string, Record<string, unknown>>;
let writes: Write[];
let claims: Map<string, Record<string, unknown>>;

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

let batchCommits = 0;

const fakeDb = {
  doc: docRef,
  // No checkout attempts exist in these tests; the flag step finds none.
  collection: () => {
    const q = { where: () => q, get: async () => ({ docs: [] }) };
    return q;
  },
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
      delete: (ref: { __path: string }) => {
        staged.push({ op: "delete", path: ref.__path });
      },
      commit: async () => {
        batchCommits += 1;
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

import { DELETE, POST } from "./route";

/** Paystack's `GET /balance` envelope for a healthy ZAR account. */
function balanceFetch(
  body: unknown = { status: true, data: [{ currency: "ZAR", balance: 0 }] },
  status = 200,
) {
  const spy = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function call(
  handler: typeof POST | typeof DELETE,
  opts: { uid?: string; id?: string; body?: Record<string, unknown> | string } = {},
) {
  const id = opts.id ?? SUB;
  const raw =
    typeof opts.body === "string"
      ? opts.body
      : JSON.stringify(opts.body ?? { secretKey: LIVE_KEY });
  return handler(
    new Request(`http://app.local/api/sub-accounts/${id}/paystack-connection`, {
      method: handler === POST ? "POST" : "DELETE",
      headers: {
        "content-type": "application/json",
        "x-user-uid": opts.uid ?? "uid_admin",
      },
      ...(handler === POST ? { body: raw } : {}),
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  writes = [];
  batchCommits = 0;
  docs = new Map<string, Record<string, unknown>>([
    [`subAccounts/${SUB}`, { agencyId: "ag_1", paymentsEnabledByAgency: true }],
    [
      `subAccounts/${OTHER_SUB}`,
      { agencyId: "ag_1", paymentsEnabledByAgency: true },
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
    ["uid_other_admin", { status: "active", agencyId: "ag_1", agencyRole: null }],
  ]);
  process.env.NEXT_PUBLIC_APP_URL = "https://app.local";
  balanceFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth and tenancy", () => {
  it("refuses a collaborator who is not an admin, and writes nothing", async () => {
    const { status, body } = await json(await call(POST, { uid: "uid_member" }));
    expect(status).toBe(403);
    expect(body.error).toBe("Sub-account admin only");
    expect(writes).toEqual([]);
  });

  it("refuses a collaborator on DELETE too", async () => {
    const { status } = await json(await call(DELETE, { uid: "uid_member" }));
    expect(status).toBe(403);
    expect(writes).toEqual([]);
  });

  it("refuses an admin of a DIFFERENT sub-account", async () => {
    // `uid_other_admin` is a genuine admin — of sa_2 — so a route that asked
    // "is an admin somewhere" rather than "is an admin HERE" would connect
    // another workspace's Paystack account.
    const { status, body } = await json(
      await call(POST, { uid: "uid_other_admin" }),
    );
    expect(status).toBe(403);
    expect(body.error).toBe("Not a member");
    expect(writes).toEqual([]);
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await POST(
      new Request(`http://app.local/x`, {
        method: "POST",
        body: JSON.stringify({ secretKey: LIVE_KEY }),
      }),
      { params: Promise.resolve({ id: SUB }) },
    );
    expect(res.status).toBe(401);
    expect(writes).toEqual([]);
  });
});

describe("the paymentsEnabledByAgency gate", () => {
  const off = { agencyId: "ag_1" };

  it("403s POST when the agency has Payments switched off", async () => {
    docs.set(`subAccounts/${SUB}`, off);
    const { status, body } = await json(await call(POST));
    expect(status).toBe(403);
    expect(body.error).toBe(
      "Payments isn't enabled for this workspace. Ask your agency to turn it on.",
    );
    expect(writes).toEqual([]);
  });

  it("still lets a tenant DISCONNECT when Payments is switched off", async () => {
    // Revoking a stored live secret key must not depend on someone else
    // re-enabling a feature first, or switching Payments off would strand the
    // tenant holding a credential it cannot remove.
    docs.set(`subAccounts/${SUB}`, off);
    const { status, body } = await json(await call(DELETE));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(writes.map((w) => w.op)).toEqual(["set", "delete"]);
  });
});

describe("key validation", () => {
  it("names the mistake when the PUBLIC key is pasted, and probes nothing", async () => {
    const fetchSpy = balanceFetch();
    const { status, body } = await json(
      await call(POST, { body: { secretKey: "pk_live_t3" } }),
    );
    expect(status).toBe(400);
    expect(body.error).toContain("PUBLIC key");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it.each([
    ["a Stripe restricted key", "rk_live_t5"],
    ["a Stripe secret key with the wrong shape", "sk_t4"],
    ["free text", "my paystack key"],
    ["a blank string", "   "],
  ])("refuses %s without probing or writing", async (_name, key) => {
    const fetchSpy = balanceFetch();
    const { status } = await json(await call(POST, { body: { secretKey: key } }));
    expect(status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("refuses a body that isn't JSON", async () => {
    const { status, body } = await json(await call(POST, { body: "not json" }));
    expect(status).toBe(400);
    expect(body.error).toBe("Invalid JSON body");
    expect(writes).toEqual([]);
  });
});

describe("the probe", () => {
  it("stores nothing when Paystack refuses the key, and passes its message on", async () => {
    // Paystack answers a refused key with HTTP 401 and its own message.
    balanceFetch({ status: false, message: "Invalid key" }, 401);
    const { status, body } = await json(await call(POST));
    expect(status).toBe(400);
    expect(body.error).toBe("Paystack: Invalid key");
    expect(writes).toEqual([]);
  });

  it("stores nothing when Paystack is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const { status } = await json(await call(POST));
    // A network failure is a BillingError(502) from the client; the route
    // surfaces it as a 400 with Paystack's wording rather than inventing one.
    expect([400, 502]).toContain(status);
    expect(writes).toEqual([]);
  });

  it("authenticates the probe with the PASTED key, not the deployment's", async () => {
    // The whole point of the per-tenant rail. Probing with
    // `PAYSTACK_SECRET_KEY` would verify the agency's account and happily
    // store an unverified tenant key.
    process.env.PAYSTACK_SECRET_KEY = "sk_live_t6";
    const fetchSpy = balanceFetch();
    await call(POST);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.paystack.co/balance");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${LIVE_KEY}`,
    );
    delete process.env.PAYSTACK_SECRET_KEY;
  });
});

describe("connect", () => {
  it("stores the key privately and publishes only display metadata", async () => {
    const { status, body } = await json(await call(POST));
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      currencies: ["ZAR"],
      livemode: true,
      webhookUrl: `https://app.local/api/webhooks/paystack/sa/${SUB}`,
    });

    const secret = writes.find((w) => w.path === SECRET_PATH);
    expect(secret?.data).toEqual({ secretKey: LIVE_KEY });

    const parent = writes.find((w) => w.path === `subAccounts/${SUB}`);
    expect(parent?.opts).toEqual({ merge: true });
    const meta = (parent?.data as { paystackConnectionMeta: Record<string, unknown> })
      .paystackConnectionMeta;
    expect(meta).toMatchObject({
      webhookSeenAt: null,
      webhookUrl: `https://app.local/api/webhooks/paystack/sa/${SUB}`,
      currencies: ["ZAR"],
      livemode: true,
      keyLast4: LIVE_KEY.slice(-4),
    });
  });

  it("reads test mode off the key prefix", async () => {
    await call(POST, { body: { secretKey: TEST_KEY } });
    const parent = writes.find((w) => w.path === `subAccounts/${SUB}`);
    const meta = (parent?.data as { paystackConnectionMeta: { livemode: boolean } })
      .paystackConnectionMeta;
    expect(meta.livemode).toBe(false);
  });

  it("leaks no part of the key to the sub-account doc, the response, or a log line", async () => {
    const sinks: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        sinks.push(args.map((a) => String(a)).join(" "));
      });
    }

    const res = await call(POST);
    const raw = await res.text();

    const parent = writes.find((w) => w.path === `subAccounts/${SUB}`);
    const exposed = [raw, JSON.stringify(parent), sinks.join("\n")].join("\n");
    expect(exposed).not.toContain(LIVE_KEY);
    // The last 4 are deliberately public; anything longer is a leak. 8 chars is
    // the shortest window that a `keyLast4` cannot satisfy.
    for (let i = 0; i + 8 <= LIVE_KEY.length; i++) {
      expect(exposed).not.toContain(LIVE_KEY.slice(i, i + 8));
    }
    // Guards the guard: the fixture must be findable when it IS present, or
    // every assertion above passes against any pair of strings.
    expect(JSON.stringify(writes.find((w) => w.path === SECRET_PATH))).toContain(
      LIVE_KEY,
    );

    vi.restoreAllMocks();
  });
});

describe("disconnect", () => {
  it("clears the meta and deletes the secret in ONE atomic batch", async () => {
    // Both writes must land together. Sequentially, a retried Paystack webhook
    // arriving between them still finds the secret, verifies, and stamps
    // `paystackConnectionMeta.webhookSeenAt` — a dotted-path update over a null
    // parent recreates the map, leaving the card showing "Connected" for a
    // tenant whose key is gone. `writes` is only populated by commit(), so a
    // regression to two awaits fails this.
    const { status, body } = await json(await call(DELETE));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(writes).toEqual([
      {
        op: "set",
        path: `subAccounts/${SUB}`,
        data: { paystackConnectionMeta: null, updatedAt: "SERVER_TS" },
        opts: { merge: true },
      },
      { op: "delete", path: SECRET_PATH },
    ]);
    expect(batchCommits).toBe(1);
  });
});
