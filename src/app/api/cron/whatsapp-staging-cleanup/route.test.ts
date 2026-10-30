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
let pageCalls: Array<{ maxResults?: number; pageToken?: string; autoPaginate?: boolean }>;

vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({
    bucket: () => ({
      // Paged like the real client with autoPaginate: false — a page of at
      // most maxResults, and the next query only when more remain.
      getFiles: async (q: { prefix?: string; maxResults?: number; pageToken?: string; autoPaginate?: boolean }) => {
        listPrefixes.push(q.prefix);
        pageCalls.push({ maxResults: q.maxResults, pageToken: q.pageToken, autoPaginate: q.autoPaginate });
        const hits = objects.filter((o) => listIgnoresPrefix || o.name.startsWith(q.prefix ?? ""));
        const start = q.pageToken ? Number(q.pageToken) : 0;
        const size = q.maxResults ?? hits.length;
        const page = hits.slice(start, start + size);
        const next = start + size < hits.length ? { ...q, pageToken: String(start + size) } : null;
        return [
          page.map((o) => ({
            name: o.name,
            metadata: { timeCreated: o.timeCreated },
            delete: async () => {
              deleted.push(o.name);
            },
          })),
          next,
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
import { sweepStaleStaged } from "@/lib/comms/whatsapp/staged-upload";

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
  pageCalls = [];
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
    expect(await res.json()).toEqual({ deleted: 1, kept: 2, truncated: false });
    expect(deleted).toEqual(["whatsapp-staging/ag1/sa1/u1/old"]);
  });

  it("lists by the staging prefix, and nothing wider, one page at a time", async () => {
    await cron();
    expect(listPrefixes).toEqual(["whatsapp-staging/"]);
    expect(pageCalls).toEqual([{ maxResults: 500, pageToken: undefined, autoPaginate: false }]);
  });

  it("still touches nothing outside staging when the listing returns more than asked for", async () => {
    listIgnoresPrefix = true;
    await cron();
    expect(deleted).toEqual(["whatsapp-staging/ag1/sa1/u1/old"]);
  });
});

describe("sweepStaleStaged — paging and the per-run bound", () => {
  const old = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `whatsapp-staging/ag1/sa1/u1/old${i}`, timeCreated: ago(2 * HOUR) }));

  it("walks every page, following the page token", async () => {
    objects = [...old(5), { name: "whatsapp-staging/ag1/sa1/u1/young", timeCreated: ago(60_000) }];
    const r = await sweepStaleStaged(Date.now(), { pageSize: 2, maxDeletes: 100 });
    expect(r).toEqual({ deleted: 5, kept: 1, truncated: false });
    expect(pageCalls.map((c) => c.pageToken)).toEqual([undefined, "2", "4"]);
    expect(pageCalls.every((c) => c.maxResults === 2 && c.autoPaginate === false)).toBe(true);
  });

  it("stops at maxDeletes and says the run was truncated, leaving the rest for the next run", async () => {
    objects = old(7);
    const r = await sweepStaleStaged(Date.now(), { pageSize: 2, maxDeletes: 3 });
    expect(r.truncated).toBe(true);
    expect(deleted).toHaveLength(3);
    // No listing past the page where the bound was reached.
    expect(pageCalls).toHaveLength(2);
  });

  it("is not truncated when the bound is reached exactly on the last object", async () => {
    objects = old(3);
    const r = await sweepStaleStaged(Date.now(), { pageSize: 2, maxDeletes: 3 });
    expect(r).toEqual({ deleted: 3, kept: 0, truncated: false });
  });
});
