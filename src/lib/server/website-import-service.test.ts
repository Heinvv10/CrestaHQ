import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { MAX_WEBSITES_PER_SUBACCOUNT } from "@/lib/website/limits";
import { sampleWebsiteConfig } from "@/types/website";

/**
 * syncClientSitesFromGitpage imports the copies a client made in gitpage
 * (Duplicate) as ready website docs. Each import is one transaction that
 * counts the cap, reads the tombstone and the existing docs, and creates
 * (not upstream, which checked first and created after): two syncs at once
 * must never pass the cap or import a site twice. Real service + real
 * gitpage client over the in-memory Firestore, whose transactions re-run on
 * contention as Firestore's do; only the outbound fetch is stubbed.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { pageIdsOf, syncClientSitesFromGitpage } = await import("./website-import-service");

const COL = "subAccounts/sa1/website";
const SOURCE = "64b7f0c2a1d3e4f5a6b7c8d0";
const id = (n: number) => `64b7f0c2a1d3e4f5a6b7c8${String(n).padStart(2, "0")}`;
const fetchMock = vi.fn();
const ORIGINAL = { key: process.env.GITPAGE_API_KEY, url: process.env.GITPAGE_API_URL };
let sites: Array<Record<string, unknown>>;

const copy = (n: number, patch: Record<string, unknown> = {}) => ({
  pageId: id(n), status: "Published", liveUrl: `https://copy-${n}.gitlab.io/`, origin: "duplicate",
  duplicatedFrom: SOURCE, quality: "premium", repoName: `copy-${n}`, ...patch,
});
const seedSite = (siteId: string, patch: Record<string, unknown> = {}) =>
  mem.seed(`${COL}/${siteId}`, { id: siteId, agencyId: "ag1", subAccountId: "sa1", status: "ready", name: siteId, config: sampleWebsiteConfig(), ...patch });
const docs = () => mem.list(COL);

beforeEach(() => {
  process.env.GITPAGE_API_KEY = "gp_test_key";
  process.env.GITPAGE_API_URL = "https://gitpage.test";
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme", websiteEnabledByAgency: true });
  sites = [];
  fetchMock.mockReset().mockImplementation(async (url: string, init?: { method?: string }) =>
    init?.method === "POST" ? Response.json({ ok: true }) : Response.json({ sites }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, value] of [["GITPAGE_API_KEY", ORIGINAL.key], ["GITPAGE_API_URL", ORIGINAL.url]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("syncClientSitesFromGitpage", () => {
  it("imports a published copy as a ready site, named and configured from the site it was copied from", async () => {
    seedSite("src", { name: "Peak", gitpagePageId: SOURCE });
    sites = [copy(1, { customDomain: "www.peak.test" })];
    expect(await syncClientSitesFromGitpage("sa1")).toEqual({ imported: 1 });
    expect(mem.read(`${COL}/gp-${id(1)}`)).toMatchObject({
      id: `gp-${id(1)}`, agencyId: "ag1", subAccountId: "sa1", name: "Peak (copy)", status: "ready",
      liveUrl: "https://copy-1.gitlab.io/", gitpagePageId: id(1), importedPageId: id(1), customDomain: "www.peak.test", importedFrom: "gitpage",
      config: { heading: sampleWebsiteConfig().heading },
    });
    // The client's name is sent for gitpage's Client filter.
    const rename = fetchMock.mock.calls.find(([, init]) => init?.method === "POST") as [string, { body: string }];
    expect(JSON.parse(rename[1].body)).toEqual({ action: "rename", subAccountId: "sa1", subAccountName: "Acme" });
  });

  it("skips a copy already known by gitpagePageId, replacesGitpagePageId or importedPageId, or already imported under gp-<pageId>", async () => {
    seedSite("a", { gitpagePageId: id(1) });
    seedSite("b", { replacesGitpagePageId: id(2) });
    seedSite(`gp-${id(3)}`, { gitpagePageId: null });
    // An imported copy rebuilt since: its own id is not gp-<pageId> any more in spirit, its record is.
    seedSite("c", { gitpagePageId: id(9), importedPageId: id(4) });
    sites = [copy(1), copy(2), copy(3), copy(4)];
    expect(await syncClientSitesFromGitpage("sa1")).toEqual({ imported: 0 });
    expect(docs()).toHaveLength(4);
  });

  it("contention that outlasts the retries stops the loop quietly: nothing imported, no throw, no further tries", async () => {
    sites = [copy(1), copy(2), copy(3)];
    const tx = vi.spyOn(mem.db, "runTransaction").mockRejectedValue(Object.assign(new Error("10 ABORTED: contention"), { code: 10 }));
    expect(await syncClientSitesFromGitpage("sa1")).toEqual({ imported: 0 });
    expect(tx).toHaveBeenCalledTimes(1);
    expect(docs()).toHaveLength(0);
  });

  it("never brings back a deleted site (tombstoned)", async () => {
    mem.seed(`subAccounts/sa1/websiteDismissed/${id(1)}`, { pageId: id(1) });
    sites = [copy(1)];
    expect(await syncClientSitesFromGitpage("sa1")).toEqual({ imported: 0 });
    expect(docs()).toHaveLength(0);
  });

  it("skips what is not a published duplicate with a valid address and id", async () => {
    sites = [
      copy(1, { origin: "build" }),
      copy(2, { status: "processing" }),
      copy(3, { liveUrl: "http://copy.gitlab.io/" }),
      copy(4, { pageId: "../../evil" }),
      copy(5, { liveUrl: "https://10.0.0.1/" }),
    ];
    expect(await syncClientSitesFromGitpage("sa1")).toEqual({ imported: 0 });
    expect(mem.all().filter((d) => d.path.startsWith(COL))).toEqual([]);
  });

  it("respects the cap: four sites and three copies import one", async () => {
    expect(MAX_WEBSITES_PER_SUBACCOUNT).toBe(5);
    for (const s of ["a", "b", "c", "d"]) seedSite(s);
    sites = [copy(1), copy(2), copy(3)];
    expect(await syncClientSitesFromGitpage("sa1")).toEqual({ imported: 1 });
    expect(docs()).toHaveLength(MAX_WEBSITES_PER_SUBACCOUNT);
  });

  it("two syncs at once never pass the cap and never import a site twice", async () => {
    for (const s of ["a", "b", "c"]) seedSite(s);
    sites = [copy(1), copy(2), copy(3), copy(4)];
    const [x, y] = await Promise.all([syncClientSitesFromGitpage("sa1"), syncClientSitesFromGitpage("sa1")]);
    expect(x.imported + y.imported).toBe(2);
    const all = docs();
    expect(all).toHaveLength(MAX_WEBSITES_PER_SUBACCOUNT);
    const pageIds = all.map((d) => d.gitpagePageId).filter(Boolean);
    expect(new Set(pageIds).size).toBe(pageIds.length);
  });

  it("two imports committing in the same instant are serialised by the limits doc: the cap holds", async () => {
    for (const s of ["a", "b", "c", "d"]) seedSite(s);
    // Each sync sees a different copy, so only the shared limits doc can stop the second.
    const lists = [[copy(1)], [copy(2)]];
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
      init?.method === "POST" ? Response.json({ ok: true }) : Response.json({ sites: lists.shift() ?? [] }),
    );
    // Both transactions finish their first attempt before either commits.
    const runTransaction = mem.db.runTransaction;
    const waiting: Array<() => void> = [];
    let armed = true;
    vi.spyOn(mem.db, "runTransaction").mockImplementation((fn) =>
      runTransaction(async (tx) => {
        const out = await fn(tx);
        if (armed) {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            if (waiting.length === 2) {
              armed = false;
              waiting.forEach((w) => w());
            }
          });
        }
        return out;
      }),
    );
    const [x, y] = await Promise.all([syncClientSitesFromGitpage("sa1"), syncClientSitesFromGitpage("sa1")]);
    expect(armed).toBe(false);
    expect(x.imported + y.imported).toBe(1);
    expect(docs()).toHaveLength(MAX_WEBSITES_PER_SUBACCOUNT);
  });

  it("imports nothing with the gate off, without gitpage, or for a path-shaped id", async () => {
    sites = [copy(1)];
    mem.seed("subAccounts/sa1", { agencyId: "ag1", websiteEnabledByAgency: false });
    expect(await syncClientSitesFromGitpage("sa1")).toEqual({ imported: 0 });
    mem.seed("subAccounts/sa1", { agencyId: "ag1", websiteEnabledByAgency: true });
    expect(await syncClientSitesFromGitpage("sa1/website/x")).toEqual({ imported: 0 });
    delete process.env.GITPAGE_API_KEY;
    expect(await syncClientSitesFromGitpage("sa1")).toEqual({ imported: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(docs()).toHaveLength(0);
  });

  it("never takes a copy's config from another sub-account's site", async () => {
    mem.seed(`subAccounts/sa2/website/src`, { id: "src", agencyId: "ag1", subAccountId: "sa2", name: "Secret", gitpagePageId: SOURCE, config: { heading: "Other client" } });
    // A doc under sa1 stamped with another sub-account is not this one's either.
    seedSite("stray", { subAccountId: "sa2", gitpagePageId: SOURCE, name: "Stray", config: { heading: "Stray" } });
    sites = [copy(1)];
    await syncClientSitesFromGitpage("sa1");
    expect(mem.read(`${COL}/gp-${id(1)}`)).toMatchObject({ name: "copy-1", config: { heading: "" } });
  });
});

describe("pageIdsOf", () => {
  it("lists the current, the replaced and the imported-from pageId, ObjectIds only", () => {
    expect(pageIdsOf({ gitpagePageId: id(1), replacesGitpagePageId: id(2), importedPageId: id(3) })).toEqual([id(1), id(2), id(3)]);
    expect(pageIdsOf({ gitpagePageId: "page_42", replacesGitpagePageId: id(1), importedPageId: "../x" })).toEqual([id(1)]);
  });

  it("never reads a page id from the doc id: a doc named gp-<X> without importedPageId stands for nothing of X's", () => {
    const doc = { id: `gp-${id(7)}`, gitpagePageId: null, replacesGitpagePageId: null } as Parameters<typeof pageIdsOf>[0];
    expect(pageIdsOf(doc)).toEqual([]);
  });
});
