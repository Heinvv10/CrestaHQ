import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  reads: [] as string[],
  fail: false,
  /** When set, a read waits for it, so a test can act while the read is in flight. */
  gate: null as Promise<void> | null,
}));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => "ts" } }));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => {
        m.reads.push(path);
        if (m.gate) await m.gate;
        if (m.fail) throw new Error("backend unavailable");
        const data = m.docs.get(path);
        return { exists: !!data, data: () => data };
      },
    }),
  }),
}));

import { LOGO_PER_IP_LIMIT } from "@/lib/brand/logo-rate-limit";
import { LOGO_CACHE_MAX_BYTES, LOGO_CACHE_TTL_MS } from "@/lib/brand/logo-cache";

// Fresh module state (logo cache + limiter buckets) per test.
let GET: typeof import("./route").GET;
let cacheStats: typeof import("@/lib/brand/logo-cache").logoCacheStats;

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const get = (scope: string, id: string, query = "", xff?: string) =>
  GET(
    new Request(`https://crm.example.com/api/brand/logo/${scope}/${id}${query}`, {
      headers: xff ? { "x-forwarded-for": xff } : {},
    }),
    { params: Promise.resolve({ scope, id }) },
  );

beforeEach(async () => {
  vi.resetModules();
  ({ GET } = await import("./route"));
  ({ logoCacheStats: cacheStats } = await import("@/lib/brand/logo-cache"));
  vi.restoreAllMocks();
  m.docs.clear();
  m.reads.length = 0;
  m.fail = false;
  m.gate = null;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

it("serves a sub-account logo from subAccounts/{id}/private/brandLogo", async () => {
  m.docs.set("subAccounts/sa1/private/brandLogo", { data: PNG_BYTES.toString("base64"), mime: "image/png", version: 7 });
  const res = await get("sa", "sa1", "?v=7");
  expect(res.status).toBe(200);
  expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-disposition")).toBe("inline");
  expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  expect(res.headers.get("cache-control")).toContain("immutable");
});

it("serves an agency logo from agencies/{id}/brandAssets/logo", async () => {
  m.docs.set("agencies/ag1/brandAssets/logo", { data: PNG_BYTES.toString("base64"), mime: "image/png", version: 1 });
  const res = await get("agency", "ag1", "?v=1");
  expect(res.status).toBe(200);
  expect(m.reads).toEqual(["agencies/ag1/brandAssets/logo"]);
});

it("takes Content-Type from the stored mime only, never the bytes or the URL", async () => {
  // PNG bytes stored with a webp mime: the stored value wins, not a sniff.
  m.docs.set("subAccounts/sa1/private/brandLogo", { data: PNG_BYTES.toString("base64"), mime: "image/webp", version: 7 });
  const res = await get("sa", "sa1", "?v=7&type=text/html");
  expect(res.headers.get("content-type")).toBe("image/webp");
});

it("404s a stored mime outside PNG/WebP", async () => {
  m.docs.set("subAccounts/sa1/private/brandLogo", { data: "PHN2Zy8+", mime: "image/svg+xml", version: 7 });
  expect((await get("sa", "sa1", "?v=7")).status).toBe(404);
  m.docs.set("subAccounts/sa1/private/brandLogo", { data: "PHN2Zy8+", mime: "text/html", version: 7 });
  expect((await get("sa", "sa1", "?v=7")).status).toBe(404);
});

it("caches as immutable only for the stored version", async () => {
  m.docs.set("subAccounts/sa1/private/brandLogo", { data: PNG_BYTES.toString("base64"), mime: "image/png", version: 7 });
  for (const q of ["", "?v=6", "?v=", "?v=7x"]) {
    const res = await get("sa", "sa1", q);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  }
});

it("404s a missing logo", async () => {
  expect((await get("sa", "nope")).status).toBe(404);
});

it("404s an unknown scope without reading", async () => {
  expect((await get("users", "u1")).status).toBe(404);
  expect((await get("agencies", "ag1")).status).toBe(404);
  expect(m.reads).toEqual([]);
});

it.each(["..", ".", "__x__", "a/b", "a%2Fb", "a.b", "x".repeat(129), ""])(
  "404s a bad id %j without reading",
  async (id) => {
    expect((await get("sa", id)).status).toBe(404);
    expect(m.reads).toEqual([]);
  },
);

it("404s (never 500s) when the read throws", async () => {
  m.fail = true;
  expect((await get("sa", "sa1")).status).toBe(404);
  expect(console.warn).toHaveBeenCalledWith("[brand/logo] read failed:", "backend unavailable");
});

describe("per-client rate limit", () => {
  const seed = () =>
    m.docs.set("subAccounts/sa1/private/brandLogo", { data: PNG_BYTES.toString("base64"), mime: "image/png", version: 7 });

  // A fresh id with no logo every call: never a cache hit (positive or
  // negative), so each request is a counted miss.
  let fresh = 0;
  const miss = (_i: number, xff: string) => get("sa", `miss${fresh++}`, "", xff);

  it("serves 1000 misses a minute with one read each, then 429s without reading", async () => {
    for (let i = 0; i < 1000; i++) {
      expect((await miss(i, "203.0.113.10")).status).toBe(404);
    }
    expect(m.reads).toHaveLength(1000);
    const refused = await miss(1000, "203.0.113.10");
    expect(refused.status).toBe(429);
    const retry = Number(refused.headers.get("retry-after"));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    expect(m.reads).toHaveLength(1000);
    // Another client keeps its own budget.
    seed();
    expect((await get("sa", "sa1", "", "203.0.113.11")).status).toBe(200);
  });

  it("keys on the proxy-appended hop, so a forged left-most X-Forwarded-For buys no fresh budget", async () => {
    for (let i = 0; i < LOGO_PER_IP_LIMIT; i++) await miss(i, `10.0.${i >> 8}.${i & 255}, 203.0.113.20`);
    expect((await miss(-1, "198.51.100.99, 203.0.113.20")).status).toBe(429);
  });

  it("never evicts a client that keeps hitting while new clients flood the table", async () => {
    for (let i = 0; i < LOGO_PER_IP_LIMIT; i++) await miss(i, "203.0.113.30");
    for (let i = 0; i < 10_050; i++) {
      await miss(i, `192.0.${i >> 8}.${i & 255}`);
      if (i % 1000 === 0) await miss(i, "203.0.113.30");
    }
    expect((await miss(-1, "203.0.113.30")).status).toBe(429);
  });
});

describe("decoded-logo cache", () => {
  const OLD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]);
  const NEW = Buffer.from([0x89, 0x50, 0x4e, 0x47, 8]);
  const store = (bytes: Buffer, version: number) =>
    m.docs.set("subAccounts/sa1/private/brandLogo", { data: bytes.toString("base64"), mime: "image/png", version });

  it("serves a hit with no read, immutable, with the same safe headers", async () => {
    store(OLD, 7);
    expect((await get("sa", "sa1", "?v=7")).status).toBe(200);
    expect(m.reads).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      const res = await get("sa", "sa1", "?v=7");
      expect(Buffer.from(await res.arrayBuffer()).equals(OLD)).toBe(true);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toContain("immutable");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    }
    expect(m.reads).toHaveLength(1);
  });

  it("does not rate-limit a hit (a shared prefetching proxy past its miss budget)", async () => {
    store(OLD, 7);
    await get("sa", "sa1", "?v=7", "203.0.113.41"); // primed by another client
    for (let i = 0; i < LOGO_PER_IP_LIMIT; i++) await get("sa", `miss${i}`, "", "203.0.113.40");
    expect((await get("sa", "miss-x", "", "203.0.113.40")).status).toBe(429);
    const reads = m.reads.length;
    for (let i = 0; i < 25; i++) expect((await get("sa", "sa1", "?v=7", "203.0.113.40")).status).toBe(200);
    for (let i = 0; i < 25; i++) expect((await get("sa", "sa1", "", "203.0.113.40")).status).toBe(200);
    expect(m.reads).toHaveLength(reads);
  });

  it("serves the latest bytes to an older or missing ?v without a read, never immutable (breaker R4)", async () => {
    store(NEW, 8);
    for (let i = 0; i < 5; i++) {
      for (const q of ["?v=7", ""]) {
        const res = await get("sa", "sa1", q);
        expect(res.status).toBe(200);
        expect(Buffer.from(await res.arrayBuffer()).equals(NEW)).toBe(true);
        expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      }
    }
    expect(m.reads.length).toBeLessThanOrEqual(1);
    // The stored version itself is still immutable, from the same entry.
    expect((await get("sa", "sa1", "?v=8")).headers.get("cache-control")).toContain("immutable");
    expect(m.reads).toHaveLength(1);
  });

  it("does not count latest-served requests as misses", async () => {
    store(NEW, 8);
    await get("sa", "sa1", "", "203.0.113.50");
    for (let i = 0; i < LOGO_PER_IP_LIMIT + 50; i++) {
      expect((await get("sa", "sa1", i % 2 ? "?v=7" : "", "203.0.113.50")).status).toBe(200);
    }
  });

  it("rereads once the TTL has passed", async () => {
    const t0 = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    store(OLD, 7);
    await get("sa", "sa1", "?v=7");
    now.mockReturnValue(t0 + LOGO_CACHE_TTL_MS - 1);
    await get("sa", "sa1", "?v=7");
    expect(m.reads).toHaveLength(1);
    now.mockReturnValue(t0 + LOGO_CACHE_TTL_MS);
    await get("sa", "sa1", "?v=7");
    expect(m.reads).toHaveLength(2);
  });

  it("never serves an older upload under a new ?v, even one requested before it existed", async () => {
    store(OLD, 7);
    await get("sa", "sa1", "?v=7");
    // A guessed future version is a miss: it reads v7 and is served, never immutable.
    const early = await get("sa", "sa1", "?v=8");
    expect(early.headers.get("cache-control")).not.toContain("immutable");
    expect(m.reads).toHaveLength(2);
    store(NEW, 8); // re-upload, by another instance (this one's cache still holds v7)
    const res = await get("sa", "sa1", "?v=8");
    expect(Buffer.from(await res.arrayBuffer()).equals(NEW)).toBe(true);
    expect(res.headers.get("cache-control")).toContain("immutable");
    const again = await get("sa", "sa1", "?v=8");
    expect(Buffer.from(await again.arrayBuffer()).equals(NEW)).toBe(true);
  });

  it("never crosses scopes: agency ag1 and sa ag1 at the same version stay apart", async () => {
    const AGENCY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xa1]);
    const SUB = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x5a]);
    m.docs.set("agencies/ag1/brandAssets/logo", { data: AGENCY.toString("base64"), mime: "image/png", version: 7 });
    m.docs.set("subAccounts/ag1/private/brandLogo", { data: SUB.toString("base64"), mime: "image/png", version: 7 });
    const body = async (scope: string) => Buffer.from(await (await get(scope, "ag1", "?v=7")).arrayBuffer());
    // Prime both, then read each again from the cache.
    expect((await body("agency")).equals(AGENCY)).toBe(true);
    expect((await body("sa")).equals(SUB)).toBe(true);
    expect((await body("agency")).equals(AGENCY)).toBe(true);
    expect((await body("sa")).equals(SUB)).toBe(true);
    expect(m.reads).toEqual(["agencies/ag1/brandAssets/logo", "subAccounts/ag1/private/brandLogo"]);
  });

  it("holds its byte bound, evicting the oldest entry first", async () => {
    const { cacheLogo, getCachedLogo } = await import("@/lib/brand/logo-cache");
    const mb = 1024 * 1024;
    const count = Math.ceil(LOGO_CACHE_MAX_BYTES / mb) + 4;
    for (let i = 0; i < count; i++) {
      cacheLogo("sa", `s${i}`, { body: Buffer.alloc(mb), mime: "image/png", version: 1 }, 0);
      expect(cacheStats().bytes).toBeLessThanOrEqual(LOGO_CACHE_MAX_BYTES);
    }
    expect(cacheStats().bytes).toBe(cacheStats().entries * mb);
    expect(getCachedLogo("sa", "s0")).toBeNull();
    expect(getCachedLogo("sa", `s${count - 1}`)).not.toBeNull();
  });
});

describe("cache generations (W1)", () => {
  const OLD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]);

  it("a read in flight across an upload/remove never re-caches what it read", async () => {
    const { dropCachedLogo, getCachedLogo } = await import("@/lib/brand/logo-cache");
    m.docs.set("subAccounts/sa1/private/brandLogo", { data: OLD.toString("base64"), mime: "image/png", version: 7 });
    let release!: () => void;
    m.gate = new Promise((r) => (release = r));
    const pending = get("sa", "sa1", "?v=7");
    await vi.waitFor(() => expect(m.reads).toHaveLength(1));
    dropCachedLogo("sa", "sa1"); // the upload/remove lands while the read is out
    release();
    expect((await pending).status).toBe(200); // still answered with what it read
    expect(getCachedLogo("sa", "sa1")).toBeNull();
    m.gate = null;
    await get("sa", "sa1", "?v=7");
    expect(m.reads).toHaveLength(2);
    expect(getCachedLogo("sa", "sa1")).not.toBeNull(); // a read after the bump caches again
  });

  it("a miss read in flight across an upload never records the tenant as missing", async () => {
    const { dropCachedLogo } = await import("@/lib/brand/logo-cache");
    let release!: () => void;
    m.gate = new Promise((r) => (release = r));
    const pending = get("sa", "sa1", "");
    await vi.waitFor(() => expect(m.reads).toHaveLength(1));
    dropCachedLogo("sa", "sa1");
    release();
    expect((await pending).status).toBe(404);
    m.gate = null;
    m.docs.set("subAccounts/sa1/private/brandLogo", { data: OLD.toString("base64"), mime: "image/png", version: 7 });
    expect((await get("sa", "sa1", "?v=7")).status).toBe(200);
  });
});

describe("negative cache (W3)", () => {
  it("404s a repeat for an absent logo without a read for 10 s, then rereads", async () => {
    const { LOGO_MISSING_TTL_MS } = await import("@/lib/brand/logo-cache");
    expect(LOGO_MISSING_TTL_MS).toBe(10_000);
    const t0 = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    expect((await get("sa", "nope")).status).toBe(404);
    now.mockReturnValue(t0 + LOGO_MISSING_TTL_MS - 1);
    for (const q of ["", "", "?v=", "?v=abc", "?v=1x"]) expect((await get("sa", "nope", q)).status).toBe(404);
    expect(m.reads).toEqual(["subAccounts/nope/private/brandLogo"]);
    now.mockReturnValue(t0 + LOGO_MISSING_TTL_MS);
    expect((await get("sa", "nope")).status).toBe(404);
    expect(m.reads).toHaveLength(2);
  });

  it("a numeric ?v skips it, so an upload made on another instance shows at once", async () => {
    expect((await get("sa", "sa1")).status).toBe(404); // absence remembered here
    // Another instance writes the logo; this one never ran dropCachedLogo.
    m.docs.set("subAccounts/sa1/private/brandLogo", { data: PNG_BYTES.toString("base64"), mime: "image/png", version: 9 });
    expect((await get("sa", "sa1")).status).toBe(404); // a bare URL still waits out the 10 s
    const res = await get("sa", "sa1", "?v=9");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(m.reads).toHaveLength(2);
  });

  it("does not spend the limiter on a known-missing repeat", async () => {
    await get("sa", "nope", "", "203.0.113.60");
    for (let i = 0; i < LOGO_PER_IP_LIMIT + 10; i++) {
      expect((await get("sa", "nope", "", "203.0.113.60")).status).toBe(404);
    }
    expect(m.reads).toHaveLength(1);
  });

  it("keeps scopes apart and never caches a failed read as missing", async () => {
    await get("agency", "x1");
    m.docs.set("subAccounts/x1/private/brandLogo", { data: PNG_BYTES.toString("base64"), mime: "image/png", version: 1 });
    expect((await get("sa", "x1")).status).toBe(200);
    m.fail = true;
    expect((await get("sa", "y1")).status).toBe(404);
    m.fail = false;
    m.docs.set("subAccounts/y1/private/brandLogo", { data: PNG_BYTES.toString("base64"), mime: "image/png", version: 1 });
    expect((await get("sa", "y1")).status).toBe(200);
  });

  it("an upload/remove on this instance clears the tenant's negative entry", async () => {
    const { dropCachedLogo } = await import("@/lib/brand/logo-cache");
    await get("sa", "sa1");
    m.docs.set("subAccounts/sa1/private/brandLogo", { data: PNG_BYTES.toString("base64"), mime: "image/png", version: 7 });
    dropCachedLogo("sa", "sa1");
    expect((await get("sa", "sa1", "?v=7")).status).toBe(200);
  });

  it("holds its key bound, oldest first", async () => {
    const { cacheMissingLogo, isKnownMissingLogo, LOGO_MISSING_MAX_KEYS } = await import("@/lib/brand/logo-cache");
    for (let i = 0; i < LOGO_MISSING_MAX_KEYS + 5; i++) cacheMissingLogo("sa", `n${i}`, 0);
    expect(cacheStats().missing).toBe(LOGO_MISSING_MAX_KEYS);
    expect(isKnownMissingLogo("sa", "n0")).toBe(false);
    expect(isKnownMissingLogo("sa", `n${LOGO_MISSING_MAX_KEYS + 4}`)).toBe(true);
  });
});
