import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A refused connect (409: the number is already connected to another
 * workspace) must leave this workspace's EXISTING Cloud credentials exactly as
 * they were. Firestore is a recording in-memory fake; the uniqueness query is
 * answered from `clashIds`.
 */

const SUB = "sub-a";
const SECRET_PATH = `subAccounts/${SUB}/private/whatsappCloudConnection`;

let store: Map<string, Record<string, unknown>>;
let clashIds: string[];

const docRef = (path: string) => ({
  path,
  get: async () => ({
    exists: store.has(path),
    data: () => store.get(path),
  }),
  set: async (data: Record<string, unknown>) => {
    store.set(path, data);
  },
  delete: async () => {
    store.delete(path);
  },
});

const fakeDb = {
  doc: (path: string) => docRef(path),
  collection: () => ({
    where: () => ({ limit: () => ({ kind: "query" }) }),
  }),
  runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const pending: Array<[string, Record<string, unknown>]> = [];
    const tx = {
      get: async () => ({ docs: clashIds.map((id) => ({ id })) }),
      set: (ref: { path: string }, data: Record<string, unknown>) => {
        pending.push([ref.path, data]);
      },
    };
    const out = await fn(tx); // throws → nothing in `pending` is committed
    for (const [p, d] of pending) store.set(p, { ...(store.get(p) ?? {}), ...d });
    return out;
  },
};

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => fakeDb }));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "ts" },
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "admin-uid" }),
}));

import { POST } from "./route";

const WORKING = { phoneNumberId: "pn-old", wabaId: "waba-old", accessToken: "tok-old" };

function connect() {
  return POST(
    new Request(`http://localhost/api/sub-accounts/${SUB}/whatsapp-cloud-connection`, {
      method: "POST",
      body: JSON.stringify({ phoneNumberId: "pn-new", wabaId: "waba-new", accessToken: "tok-new" }),
    }),
    { params: Promise.resolve({ id: SUB }) },
  );
}

beforeEach(() => {
  store = new Map();
  store.set(`subAccounts/${SUB}`, { whatsappEnabledByAgency: true });
  store.set(SECRET_PATH, { ...WORKING });
  clashIds = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ display_phone_number: "+27 00", verified_name: "X" })),
    ),
  );
});

describe("POST whatsapp-cloud-connection", () => {
  it("a refused connect (409) leaves the workspace's working credentials untouched", async () => {
    clashIds = ["other-workspace"];
    const res = await connect();
    expect(res.status).toBe(409);
    expect(store.get(SECRET_PATH)).toEqual(WORKING);
  });

  it("an accepted connect stores the new credentials and switches to the cloud rail", async () => {
    const res = await connect();
    expect(res.status).toBe(200);
    expect(store.get(SECRET_PATH)).toEqual({
      phoneNumberId: "pn-new",
      wabaId: "waba-new",
      accessToken: "tok-new",
    });
    expect(store.get(`subAccounts/${SUB}`)).toMatchObject({ whatsappProvider: "cloud" });
  });
});
