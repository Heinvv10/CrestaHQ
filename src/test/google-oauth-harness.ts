import { vi } from "vitest";

/**
 * Shared fakes for the Google connect / callback / disconnect route tests.
 *
 * `@/lib/auth/require-tenancy` is deliberately NOT mocked: the tenancy refusal
 * is the assertion that matters most, and a mocked guard proves only that the
 * route calls something. Firestore and Firebase Auth are faked underneath it
 * instead, so the real membership lookup runs against real fake documents.
 *
 * Writes are RECORDED so a test can assert both what landed and — for the
 * refused paths — that nothing landed at all. They are also APPLIED to
 * `state.docs`, with Firestore's real semantics where they bite: `set(…,
 * {merge:true})` deep-merges nested maps (so a stale `reconnectRequired`
 * survives a merge that doesn't overwrite it), `update` replaces top-level
 * fields and fails on a missing doc.
 */

export const SUB = "sa_1";
export const OTHER_SUB = "sa_2";
export const SECRET_PATH = `subAccounts/${SUB}/private/googleConnection`;
export const SUB_PATH = `subAccounts/${SUB}`;

export interface Write {
  op: "set" | "delete" | "update" | "add";
  path: string;
  data?: Record<string, unknown>;
}

export const state = {
  docs: new Map<string, Record<string, unknown>>(),
  claims: new Map<string, Record<string, unknown>>(),
  writes: [] as Write[],
  /** Every document path read, so a test can prove a path was never touched. */
  reads: [] as string[],
};

function isPlain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlain(v) && isPlain(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function docRef(path: string) {
  return {
    __path: path,
    path,
    get: async () => ({
      exists: (state.reads.push(path), state.docs.has(path)),
      data: () => state.docs.get(path),
    }),
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      state.writes.push({ op: "set", path, data });
      const cur = state.docs.get(path);
      state.docs.set(path, opts?.merge && cur ? deepMerge(cur, data) : { ...data });
    },
    update: async (data: Record<string, unknown>) => {
      const cur = state.docs.get(path);
      if (!cur) throw new Error(`NOT_FOUND: no document to update at ${path}`);
      if (Object.keys(data).some((k) => k.includes("."))) {
        throw new Error("harness: dotted update paths are not modelled");
      }
      state.writes.push({ op: "update", path, data });
      state.docs.set(path, { ...cur, ...data });
    },
    delete: async () => {
      state.writes.push({ op: "delete", path });
      state.docs.delete(path);
    },
  };
}

let autoId = 0;

/** Docs directly under a collection path — what the GBP cache clear reads. */
function listUnder(path: string) {
  const docs = [...state.docs.keys()]
    .filter((p) => p.slice(0, p.lastIndexOf("/")) === path)
    .map((p) => ({ id: p.split("/").pop()!, ref: docRef(p), data: () => state.docs.get(p) }));
  return { empty: docs.length === 0, size: docs.length, docs };
}

function collectionRef(path: string, filters: Array<[string, unknown]> = []) {
  const matches = (d: Record<string, unknown> | undefined) =>
    filters.every(([field, value]) => d?.[field] === value);
  return {
    get: async () => {
      const all = listUnder(path);
      const docs = all.docs.filter((d) => matches(d.data()));
      return { empty: docs.length === 0, size: docs.length, docs };
    },
    /** Equality on a top-level field only — add operators when a test needs them. */
    where: (field: string, op: "==", value: unknown) => {
      if (op !== "==") throw new Error("harness: only == is modelled");
      return collectionRef(path, [...filters, [field, value]]);
    },
    doc: (id?: string) => docRef(`${path}/${id ?? `auto_${++autoId}`}`),
    add: async (data: Record<string, unknown>) => {
      const id = `auto_${++autoId}`;
      const docPath = `${path}/${id}`;
      state.writes.push({ op: "add", path: docPath, data });
      state.docs.set(docPath, { ...data });
      return { id, path: docPath };
    },
  };
}

type Ref = ReturnType<typeof docRef>;

/**
 * Reads go straight through; writes are buffered and applied when the
 * callback resolves — so a transaction that throws writes nothing.
 */
async function runTransaction<T>(
  fn: (tx: {
    get: (ref: Ref) => ReturnType<Ref["get"]>;
    set: (ref: Ref, data: Record<string, unknown>, opts?: { merge?: boolean }) => void;
    update: (ref: Ref, data: Record<string, unknown>) => void;
  }) => Promise<T>,
): Promise<T> {
  const pending: Array<() => Promise<void>> = [];
  const result = await fn({
    get: (ref) => ref.get(),
    set: (ref, data, opts) => void pending.push(() => ref.set(data, opts)),
    update: (ref, data) => void pending.push(() => ref.update(data)),
  });
  for (const apply of pending) await apply();
  return result;
}

/** Buffered like a transaction: nothing lands unless commit() runs. */
function batch() {
  const pending: Array<() => Promise<void>> = [];
  const b = {
    set: (ref: Ref, data: Record<string, unknown>, opts?: { merge?: boolean }) =>
      (pending.push(() => ref.set(data, opts)), b),
    delete: (ref: Ref) => (pending.push(() => ref.delete()), b),
    commit: async () => {
      for (const apply of pending) await apply();
    },
  };
  return b;
}

export const adminMock = () => ({
  getAdminDb: () => ({ doc: docRef, collection: collectionRef, runTransaction, batch }),
  getAdminAuth: () => ({
    getUser: async (uid: string) => ({
      customClaims: state.claims.get(uid) ?? {},
    }),
  }),
});

export const firestoreMock = () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
});

/** Fresh docs: an admin, a plain member, and an admin of a DIFFERENT sub. */
export function resetHarness(opts: { gateOn?: boolean } = {}) {
  state.writes = [];
  state.reads = [];
  state.docs = new Map<string, Record<string, unknown>>([
    [
      SUB_PATH,
      { agencyId: "ag_1", googleEnabledByAgency: opts.gateOn ?? true },
    ],
    [`subAccounts/${OTHER_SUB}`, { agencyId: "ag_1" }],
    [
      `${SUB_PATH}/subAccountMembers/uid_admin`,
      { status: "active", subAccountRole: "admin", role: "admin" },
    ],
    [
      `${SUB_PATH}/subAccountMembers/uid_member`,
      { status: "active", subAccountRole: "user", role: "user" },
    ],
    // A second genuine admin of SUB — the replay target for uid binding.
    [
      `${SUB_PATH}/subAccountMembers/uid_admin2`,
      { status: "active", subAccountRole: "admin", role: "admin" },
    ],
    // The real read-only role (src/types/tenancy.ts SubAccountRole).
    [
      `${SUB_PATH}/subAccountMembers/uid_collab`,
      { status: "active", subAccountRole: "collaborator", role: "collaborator" },
    ],
    [
      `subAccounts/${OTHER_SUB}/subAccountMembers/uid_other_admin`,
      { status: "active", subAccountRole: "admin", role: "admin" },
    ],
  ]);
  state.claims = new Map<string, Record<string, unknown>>([
    ["uid_admin", { status: "active", agencyId: "ag_1", agencyRole: null }],
    ["uid_member", { status: "active", agencyId: "ag_1", agencyRole: null }],
    ["uid_admin2", { status: "active", agencyId: "ag_1", agencyRole: null }],
    ["uid_collab", { status: "active", agencyId: "ag_1", agencyRole: null }],
    [
      "uid_other_admin",
      { status: "active", agencyId: "ag_1", agencyRole: null },
    ],
  ]);
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-state-secret";
  process.env.NEXT_PUBLIC_APP_URL = "http://app.local";
  // Real-Google mode unless a test opts into the fake. A developer shell that
  // exported a local .env (GBP_PROVIDER=fake) must not change these results.
  delete process.env.GBP_PROVIDER;
  delete process.env.GBP_FAKE_AGENCY_ID;
  delete process.env.GBP_FAKE_ALLOW_PROD_BUILD;
  process.env.GOOGLE_CLIENT_ID = "client-id.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
}

/** Stub the token endpoint. Returns the spy so callers can assert on it. */
export function stubTokenEndpoint(body: Record<string, unknown>, status = 200) {
  const spy = vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

export function request(url: string, uid = "uid_admin", method = "GET") {
  return new Request(url, { method, headers: { "x-user-uid": uid } });
}
