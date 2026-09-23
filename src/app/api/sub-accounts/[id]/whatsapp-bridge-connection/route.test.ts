import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-handler tests for the wa-agent-bridge connect/disconnect route.
 *
 * `@/lib/auth/require-tenancy` is deliberately NOT mocked: the tenancy refusal
 * is the assertion that matters most here, and a mocked guard proves only that
 * the route calls something. Firestore and Firebase Auth are faked underneath
 * it instead, so the real membership lookup runs against real fake documents.
 *
 * The fake records WRITES only — reads go through the same `doc()` and would
 * otherwise drown the one thing every guard test asserts, which is that a
 * refused connect writes nothing at all.
 */

const SUB = "sa_1";
const OTHER_SUB = "sa_2";
const TOKEN = "tok_super_secret";
const WEBHOOK_SECRET = "whsec_super_secret";
const BASE_URL = "http://bridge.local:33001";
const NUMBER = "27784356159";

const SECRET_PATH = `subAccounts/${SUB}/private/whatsappBridge`;

interface Write {
  op: "set" | "delete";
  path: string;
  data?: Record<string, unknown>;
  opts?: unknown;
}

let docs: Map<string, Record<string, unknown>>;
let writes: Write[];
/** Auto-ids handed out by `collection().doc()`, so the batch-written
 *  connection record lands on a predictable path. */
let autoId: number;
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

const fakeDb = {
  doc: docRef,
  // `storeBridgeConnection` also appends an audit record naming who connected
  // the number, as an auto-id child in the same batch.
  collection: (path: string) => ({ doc: () => docRef(`${path}/auto_${++autoId}`) }),
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

import { DELETE, POST } from "./route";

/** Health payload of a bridge that is up, paired, and accepted our token. */
const healthyBody = { connected: true, killed: false, number: NUMBER };

function stubFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response> | Promise<never>,
) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

function healthFetch(body: Record<string, unknown> | null, status = 200) {
  return stubFetch(async () =>
    body === null
      ? Promise.reject(new Error("ECONNREFUSED"))
      : new Response(JSON.stringify(body), { status }),
  );
}

function call(
  handler: typeof POST | typeof DELETE,
  opts: {
    uid?: string;
    id?: string;
    body?: Record<string, unknown> | string;
  } = {},
) {
  const id = opts.id ?? SUB;
  const raw =
    typeof opts.body === "string"
      ? opts.body
      : JSON.stringify(
          opts.body ?? {
            baseUrl: BASE_URL,
            token: TOKEN,
            webhookSecret: WEBHOOK_SECRET,
          },
        );
  return handler(
    new Request(`http://app.local/api/sub-accounts/${id}/whatsapp-bridge-connection`, {
      method: handler === POST ? "POST" : "DELETE",
      headers: {
        "content-type": "application/json",
        // Connecting is agency-owner only (the base URL is a server-side
        // fetch target); disconnecting stays open to sub-account admins.
        "x-user-uid": opts.uid ?? (handler === POST ? "uid_owner" : "uid_admin"),
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
  autoId = 0;
  docs = new Map<string, Record<string, unknown>>([
    [`subAccounts/${SUB}`, { agencyId: "ag_1", whatsappEnabledByAgency: true }],
    [`subAccounts/${OTHER_SUB}`, { agencyId: "ag_1", whatsappEnabledByAgency: true }],
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
    ["uid_owner", { status: "active", agencyId: "ag_1", agencyRole: "owner" }],
    ["uid_admin", { status: "active", agencyId: "ag_1", agencyRole: null }],
    ["uid_member", { status: "active", agencyId: "ag_1", agencyRole: null }],
    ["uid_other_admin", { status: "active", agencyId: "ag_1", agencyRole: null }],
  ]);
  healthFetch(healthyBody);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth", () => {
  it("refuses a member who is not an admin, and writes nothing", async () => {
    const { status, body } = await json(await call(POST, { uid: "uid_member" }));
    expect(status).toBe(403);
    expect(body.error).toBe("Sub-account admin only");
    expect(writes).toEqual([]);
  });

  it("refuses an admin of a DIFFERENT sub-account, and writes nothing", async () => {
    // The tenancy case. `uid_other_admin` is a genuine admin — of sa_2 — so a
    // route that checked "is an admin somewhere" rather than "is an admin
    // HERE" would connect another workspace's WhatsApp number.
    const { status, body } = await json(
      await call(POST, { uid: "uid_other_admin" }),
    );
    expect(status).toBe(403);
    expect(body.error).toBe("Not a member");
    expect(writes).toEqual([]);
  });

  it("refuses a sub-account admin — the bridge URL is fetched server-side, so only the agency owner may set it", async () => {
    const { status, body } = await json(await call(POST, { uid: "uid_admin" }));
    expect(status).toBe(403);
    expect(body.error).toBe(
      "Only your agency owner can connect a bridge by URL. Pair a number from WhatsApp settings instead.",
    );
    expect(writes).toEqual([]);
  });

  it("refuses when the agency has WhatsApp switched off", async () => {
    docs.set(`subAccounts/${SUB}`, { agencyId: "ag_1" });
    const { status, body } = await json(await call(POST));
    expect(status).toBe(403);
    expect(body.error).toBe(
      "WhatsApp isn't enabled for this workspace. Ask your agency to turn it on.",
    );
    expect(writes).toEqual([]);
  });
});

describe("credential validation", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["missing token", { baseUrl: BASE_URL, webhookSecret: WEBHOOK_SECRET }],
    [
      "blank webhook secret",
      { baseUrl: BASE_URL, token: TOKEN, webhookSecret: "   " },
    ],
    ["missing baseUrl", { token: TOKEN, webhookSecret: WEBHOOK_SECRET }],
    [
      "unparseable baseUrl",
      { baseUrl: "bridge.local", token: TOKEN, webhookSecret: WEBHOOK_SECRET },
    ],
    [
      "non-http baseUrl",
      {
        baseUrl: "ftp://bridge.local",
        token: TOKEN,
        webhookSecret: WEBHOOK_SECRET,
      },
    ],
  ];

  for (const [name, body] of cases) {
    it(`refuses ${name} before probing or writing`, async () => {
      const fetchSpy = healthFetch(healthyBody);
      const res = await json(await call(POST, { body }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        "Bridge URL, token and webhook secret are all required, and the bridge URL must be a full http:// or https:// address.",
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    });
  }

  it("refuses a body that isn't JSON", async () => {
    const { status, body } = await json(await call(POST, { body: "not json" }));
    expect(status).toBe(400);
    expect(body.error).toBe("Invalid JSON body");
    expect(writes).toEqual([]);
  });
});

describe("probe", () => {
  it("refuses an unreachable bridge with its own message", async () => {
    healthFetch(null);
    const { status, body } = await json(await call(POST));
    expect(status).toBe(400);
    expect(body.error).toBe(
      "Couldn't reach the bridge at that URL. Check the address and that the bridge process is running.",
    );
    expect(writes).toEqual([]);
  });

  it("refuses a bridge whose WhatsApp session is disconnected", async () => {
    healthFetch({ connected: false, killed: false });
    const { status, body } = await json(await call(POST));
    expect(status).toBe(400);
    expect(body.error).toBe(
      "The bridge is running but its WhatsApp session is disconnected. Re-pair the number, then connect again.",
    );
    expect(writes).toEqual([]);
  });

  it("refuses a rejected token — /v1/health answers 200 but withholds the number", async () => {
    healthFetch({ connected: true, killed: false });
    const { status, body } = await json(await call(POST));
    expect(status).toBe(400);
    expect(body.error).toBe(
      "The bridge rejected that token. Check you pasted this workspace's consumer token and not another one.",
    );
    expect(writes).toEqual([]);
  });

  it("refuses a bridge whose kill switch is on", async () => {
    // A connect that succeeded here would hand the operator a workspace that
    // looks connected and refuses every send — the same confusion readiness
    // was fixed to avoid, one layer up. Connect-time is the cheaper place to
    // say it: the operator is standing right there.
    healthFetch({ connected: true, killed: true, number: NUMBER });
    const { status, body } = await json(await call(POST));
    expect(status).toBe(400);
    expect(body.error).toMatch(/kill switch/i);
    expect(writes).toEqual([]);
  });

  it("sends the token as a bearer to /v1/health", async () => {
    const fetchSpy = healthFetch(healthyBody);
    await call(POST);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/health`);
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${TOKEN}`);
  });
});

describe("connect", () => {
  it("stores the secrets privately and switches the workspace onto the bridge", async () => {
    const { status, body } = await json(await call(POST));
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      provider: "bridge",
      displayPhoneNumber: `+${NUMBER}`,
    });

    const secret = writes.find((w) => w.path === SECRET_PATH);
    expect(secret?.data).toEqual({
      baseUrl: BASE_URL,
      token: TOKEN,
      webhookSecret: WEBHOOK_SECRET,
    });

    const parent = writes.find((w) => w.path === `subAccounts/${SUB}`);
    expect(parent?.data).toEqual({
      whatsappBridgeMeta: {
        displayPhoneNumber: `+${NUMBER}`,
        connectedAt: "SERVER_TS",
        connectedByUid: "uid_owner",
      },
      whatsappProvider: "bridge",
      updatedAt: "SERVER_TS",
    });
    expect(parent?.opts).toEqual({ merge: true });
  });

  it("strips a trailing slash off the stored base URL", async () => {
    // A pasted `http://host:33001/` otherwise becomes `//v1/send`, which the Go
    // mux does not route.
    await call(POST, {
      body: {
        baseUrl: `${BASE_URL}/`,
        token: TOKEN,
        webhookSecret: WEBHOOK_SECRET,
      },
    });
    const secret = writes.find((w) => w.path === SECRET_PATH);
    expect((secret?.data as { baseUrl: string }).baseUrl).toBe(BASE_URL);
  });

  it("leaks neither secret to the sub-account doc, the response, or a log line", async () => {
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
    expect(exposed).not.toContain(TOKEN);
    expect(exposed).not.toContain(WEBHOOK_SECRET);
    // Guards the guard: the fixtures must be findable when they ARE present,
    // or the three assertions above pass against any pair of strings.
    expect(JSON.stringify(writes.find((w) => w.path === SECRET_PATH))).toContain(
      TOKEN,
    );

    vi.restoreAllMocks();
  });
});

describe("disconnect", () => {
  it("restores Cloud, not Twilio, when the workspace still has a Cloud connection", async () => {
    // A workspace that ran on Cloud, tried the bridge, then disconnected was
    // being moved onto Twilio — silently swapping a working rail for one it
    // may never have configured — while its Cloud credentials sat untouched.
    docs.set(`subAccounts/${SUB}`, {
      ...docs.get(`subAccounts/${SUB}`),
      whatsappCloudMeta: { phoneNumberId: "1234567890" },
    });
    const { status, body } = await json(await call(DELETE));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, provider: "cloud" });
    expect(writes[0]).toMatchObject({
      op: "set",
      data: { whatsappProvider: "cloud", whatsappBridgeMeta: null },
    });
  });

  it("clears the meta, restores Twilio, and deletes the secret", async () => {
    const { status, body } = await json(await call(DELETE));
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

  it("refuses an admin of a different sub-account", async () => {
    const { status } = await json(await call(DELETE, { uid: "uid_other_admin" }));
    expect(status).toBe(403);
    expect(writes).toEqual([]);
  });
});
