import { vi } from "vitest";

/**
 * Shared fakes for the Google connect / callback / disconnect route tests.
 *
 * `@/lib/auth/require-tenancy` is deliberately NOT mocked: the tenancy refusal
 * is the assertion that matters most, and a mocked guard proves only that the
 * route calls something. Firestore and Firebase Auth are faked underneath it
 * instead, so the real membership lookup runs against real fake documents.
 *
 * Writes are RECORDED (never applied) so a test can assert both what landed
 * and — for the refused paths — that nothing landed at all.
 */

export const SUB = "sa_1";
export const OTHER_SUB = "sa_2";
export const SECRET_PATH = `subAccounts/${SUB}/private/googleConnection`;
export const SUB_PATH = `subAccounts/${SUB}`;

export interface Write {
  op: "set" | "delete";
  path: string;
  data?: Record<string, unknown>;
}

export const state = {
  docs: new Map<string, Record<string, unknown>>(),
  claims: new Map<string, Record<string, unknown>>(),
  writes: [] as Write[],
};

function docRef(path: string) {
  return {
    __path: path,
    get: async () => ({
      exists: state.docs.has(path),
      data: () => state.docs.get(path),
    }),
    set: async (data: Record<string, unknown>) => {
      state.writes.push({ op: "set", path, data });
    },
    delete: async () => {
      state.writes.push({ op: "delete", path });
    },
  };
}

export const adminMock = () => ({
  getAdminDb: () => ({ doc: docRef }),
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
