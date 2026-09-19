import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/cron/whatsapp-staging-cleanup — the daily sweep of abandoned
 * composer uploads. The QStash signature is verified for REAL, and Storage is
 * an in-memory bucket holding BOTH staging objects and the thread's stored
 * media, so "deletes only old staging objects" is checked against the one
 * prefix it must never touch.
 */

interface Obj { name: string; timeCreated: string }
let objects: Obj[];
let deleted: string[];
let listPrefixes: Array<string | undefined>;
/** When true, getFiles ignores its prefix — a listing that returns too much. */
let listIgnoresPrefix: boolean;

vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({
    bucket: () => ({
      getFiles: async (q: { prefix?: string }) => {
        listPrefixes.push(q.prefix);
        const hits = objects.filter((o) => listIgnoresPrefix || o.name.startsWith(q.prefix ?? ""));
        return [
          hits.map((o) => ({
            name: o.name,
            metadata: { timeCreated: o.timeCreated },
            delete: async () => {
              deleted.push(o.name);
            },
          })),
        ];
      },
    }),
  }),
}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminApp: () => ({ name: "test-app" }), getAdminDb: vi.fn() }));

const KEY = "sig_test_current_key_for_staging_cron";
process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
process.env.QSTASH_NEXT_SIGNING_KEY = "sig_test_next_key_for_staging_cron";

import { signQStashBody } from "../../../../../e2e/lib/qstash";
import { POST } from "./route";

const ORIGINAL = { ...process.env };
const URL_ = "http://127.0.0.1:3100/api/cron/whatsapp-staging-cleanup";

function cron(signature: string | null = signQStashBody(URL_, "{}")) {
  const headers: Record<string, string> = {};
  if (signature !== null) headers["upstash-signature"] = signature;
  return POST(new Request(URL_, { method: "POST", headers, body: "{}" }));
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 3600_000;

beforeEach(() => {
  process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = "test-bucket";
  deleted = [];
  listPrefixes = [];
  listIgnoresPrefix = false;
  objects = [
    { name: "whatsapp-staging/ag1/sa1/u1/old", timeCreated: ago(2 * HOUR) },
    { name: "whatsapp-staging/ag1/sa1/u1/young", timeCreated: ago(10 * 60_000) },
    { name: "whatsapp-staging/ag1/sa1/u1/undated", timeCreated: "" },
    { name: "whatsapp-media/ag1/sa1/c1/wamid.OLD", timeCreated: ago(90 * 24 * HOUR) },
    { name: "media/sa1/m1/logo.png", timeCreated: ago(90 * 24 * HOUR) },
  ];
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("POST /api/cron/whatsapp-staging-cleanup", () => {
  it("401s an unsigned call and deletes nothing", async () => {
    expect((await cron(null)).status).toBe(401);
    expect(deleted).toEqual([]);
  });

  it("401s a genuine signature minted for another cron route", async () => {
    const other = signQStashBody("http://127.0.0.1:3100/api/cron/gbp-retention", "{}");
    expect((await cron(other)).status).toBe(401);
    expect(deleted).toEqual([]);
  });

  it("deletes only staging objects over an hour old — never a young one, an undated one, or stored media", async () => {
    const res = await cron();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1, kept: 2 });
    expect(deleted).toEqual(["whatsapp-staging/ag1/sa1/u1/old"]);
  });

  it("lists by the staging prefix, and nothing wider", async () => {
    await cron();
    expect(listPrefixes).toEqual(["whatsapp-staging/"]);
  });

  it("still touches nothing outside staging when the listing returns more than asked for", async () => {
    listIgnoresPrefix = true;
    await cron();
    expect(deleted).toEqual(["whatsapp-staging/ag1/sa1/u1/old"]);
  });
});
