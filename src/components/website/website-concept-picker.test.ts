// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { ConceptPicker } from "./website-premium-sections";

/**
 * The picker's fetch goes to the REAL concepts route (real tenancy check,
 * real gate, real gitpage client); only gitpage itself is stubbed. So every
 * error the picker sees is a body the route actually produces, and a change
 * to the route's codes breaks these tests.
 */

const mem = createMemoryFirestore();
const claims: Record<string, Record<string, unknown>> = {
  u_member: { status: "active", agencyId: "ag1" },
};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({ getUser: async (uid: string) => ({ customClaims: claims[uid] ?? {} }) }),
}));
const { GET: conceptsRoute } = await import("@/app/api/sub-accounts/[id]/website/concepts/route");

const GITPAGE = "https://gitpage.test";
const card = (id: string, niche: string, extra: Record<string, unknown> = {}) => ({
  id, niche, name: `${id} name`, pitch: `${id} pitch`, fit: "Boutique gyms", archetype: "editorial",
  typeSystem: "serif_sans", defaultMode: "dark", modes: ["light", "dark"],
  accents: { light: "#111111", dark: "#222222" }, heroMotion: "still", ...extra,
});
const CARDS: Record<string, ReturnType<typeof card>[]> = {
  gym_fitness: [card("iron", "gym_fitness"), card("pulse", "gym_fitness")],
  home_services: [card("tradesman", "home_services")],
};

/** What gitpage answers; defaults to the niche's cards. */
let gitpage: (url: URL) => Response | Promise<Response>;
/** Who is signed in when the picker calls the route (undefined = nobody). */
let uid: string | undefined;

async function callRoute(path: string): Promise<Response> {
  const id = decodeURIComponent(path.split("/")[3]);
  return conceptsRoute(
    new Request(`https://app.test${path}`, { headers: uid ? { "x-user-uid": uid } : {} }),
    { params: Promise.resolve({ id }) },
  );
}

/** Route bodies the picker has finished reading (its next step is synchronous). */
let bodiesRead = 0;
const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
  const url = String(input);
  if (url.startsWith(GITPAGE)) return gitpage(new URL(url));
  const res = await callRoute(url);
  const json = res.json.bind(res);
  res.json = async () => {
    try {
      return await json();
    } finally {
      bodiesRead++;
    }
  };
  return res;
});

let host: HTMLDivElement;
let root: Root;
const render = (el: React.ReactElement) => act(async () => root.render(el));
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
/** Ticks until `cond` holds; throws rather than letting a test pass on a timeout. */
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${what}`);
}
const loaded = () => until(() => !host.textContent?.includes("Loading design directions"), "the load to settle");
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);
const ORIGINAL_KEY = process.env.GITPAGE_API_KEY;
const ORIGINAL_URL = process.env.GITPAGE_API_URL;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => {}); // the route logs gitpage failures
  process.env.GITPAGE_API_KEY = "gp_test_key";
  process.env.GITPAGE_API_URL = GITPAGE;
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme", websiteEnabledByAgency: true });
  mem.seed("subAccounts/sa2", { agencyId: "ag1", name: "Sibling", websiteEnabledByAgency: true });
  mem.seed("subAccounts/sa1/subAccountMembers/u_member", { role: "member", status: "active" });
  uid = "u_member";
  gitpage = (url) => Response.json({ concepts: CARDS[url.searchParams.get("niche") ?? ""] ?? [] });
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  unhandled.length = 0;
  bodiesRead = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.off("unhandledRejection", onUnhandled);
  for (const [name, value] of [["GITPAGE_API_KEY", ORIGINAL_KEY], ["GITPAGE_API_URL", ORIGINAL_URL]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type PickerProps = { subAccountId?: string; niche?: string | null; value?: string | null; onChange?: (id: string | null) => void };
const picker = (p: PickerProps = {}) =>
  createElement(ConceptPicker, {
    subAccountId: p.subAccountId ?? "sa1",
    niche: p.niche === undefined ? "gym_fitness" : p.niche,
    mode: "dark",
    value: p.value ?? null,
    onChange: p.onChange ?? (() => {}),
  });
const mount = async (p: PickerProps = {}) => {
  await render(picker(p));
  await loaded();
};
const buttons = () => Array.from(host.querySelectorAll("button"));

describe("ConceptPicker — loading and picking", () => {
  it("shows a status while loading, and calls the route with the niche", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    gitpage = async (url) => { await hold; return Response.json({ concepts: CARDS[url.searchParams.get("niche")!] }); };
    await render(picker());
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading design directions");
    expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/website/concepts?niche=gym_fitness");
    await act(async () => release());
    await loaded();
    expect(host.textContent).toContain("iron pitch");
  });

  it("omits the niche query when there is none", async () => {
    await mount({ niche: null });
    expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/website/concepts");
  });

  it("renders loaded cards with the selected one pressed, and reports picks", async () => {
    const onChange = vi.fn();
    await mount({ value: "pulse", onChange });
    expect(buttons().map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => buttons()[1].click());
    expect(onChange).toHaveBeenLastCalledWith("iron");
    await act(async () => buttons()[0].click());
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("paints a swatch only from a hex accent, and survives a card with missing fields", async () => {
    // A 200 body straight from the network (the picker's own guard, not the route's).
    fetchMock.mockImplementationOnce(async () =>
      Response.json({
        concepts: [
          { id: "ok", name: "Ok", accents: { dark: "#00ff00" } },
          // Valid CSS, so only the picker's hex check keeps it off the page.
          { id: "bad", name: "Bad", accents: { dark: "red" }, defaultMode: "dark" },
          { id: "bare", name: "Bare" },
          { id: 7, name: "not a card" },
          null,
        ],
      }),
    );
    await mount();
    const swatches = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="concept-swatch"]'));
    expect(swatches).toHaveLength(3);
    expect(swatches[0].style.backgroundColor).toBe("rgb(0, 255, 0)");
    expect(swatches[1].getAttribute("style")).toBeNull();
    expect(swatches[2].getAttribute("style")).toBeNull();
    expect(host.textContent).toContain("Bare");
  });
});

describe("ConceptPicker — the saved selection", () => {
  it("clears a saved concept a SUCCESSFUL list does not contain", async () => {
    const onChange = vi.fn();
    await mount({ value: "gone", onChange });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("clears a different niche's concept once the new niche loads successfully", async () => {
    const onChange = vi.fn();
    await mount({ niche: "gym_fitness", value: "iron", onChange });
    expect(onChange).not.toHaveBeenCalled();
    await render(picker({ niche: "home_services", value: "iron", onChange }));
    await loaded();
    expect(host.textContent).toContain("tradesman pitch");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("keeps the saved concept when the load FAILS, and says so", async () => {
    gitpage = () => Response.json({ error: "Rate limited." }, { status: 429 });
    const onChange = vi.fn();
    await mount({ niche: "home_services", value: "iron", onChange });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "The design service is unavailable right now. Your chosen design direction is kept.",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a stale response for the old niche, landing LAST, neither overwrites the cards nor clears the pick", async () => {
    const releases = new Map<string, () => void>();
    gitpage = async (url) => {
      const niche = url.searchParams.get("niche")!;
      await new Promise<void>((r) => releases.set(niche, r));
      return Response.json({ concepts: CARDS[niche] });
    };
    const onChange = vi.fn();
    await render(picker({ niche: "gym_fitness", value: null, onChange }));
    await until(() => releases.has("gym_fitness"), "the first load to reach gitpage");
    // The operator switches niche and picks before the first load returns.
    await render(picker({ niche: "home_services", value: "tradesman", onChange }));
    await until(() => releases.has("home_services"), "the second load to reach gitpage");
    await act(async () => releases.get("home_services")!());
    await until(() => bodiesRead === 1, "the second body");
    await loaded();
    expect(host.textContent).toContain("tradesman pitch");
    await act(async () => releases.get("gym_fitness")!());
    await until(() => bodiesRead === 2, "the stale body");
    await flush();
    expect(host.textContent).toContain("tradesman pitch");
    expect(host.textContent).not.toContain("iron pitch");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a response landing after unmount does not touch the selection", async () => {
    let release: (() => void) | undefined;
    gitpage = async () => {
      await new Promise<void>((r) => { release = r; });
      return Response.json({ concepts: [] });
    };
    const onChange = vi.fn();
    await render(picker({ value: "iron", onChange }));
    await until(() => release !== undefined, "the load to reach gitpage");
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => release!());
    await until(() => bodiesRead === 1, "the late body");
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});

describe("ConceptPicker — every answer the route gives ends the spinner", () => {
  // [label, arrange, expected text, fallback (build proceeds without a pick)]
  const cases: Array<[string, () => PickerProps | void, RegExp, boolean]> = [
    ["401 unauthorized (route)", () => { uid = undefined; }, /^Your session has expired/, false],
    ["403 forbidden (route)", () => ({ subAccountId: "sa2" }), /^You do not have access/, false],
    ["403 gate_off (route)", () => { mem.seed("subAccounts/sa1", { agencyId: "ag1", websiteEnabledByAgency: false }); }, /^The website builder is disabled for this sub-account\./, false],
    ["404 not_found (route)", () => ({ subAccountId: "nope" }), /^This workspace could not be found/, false],
    ["400 bad_niche (route)", () => ({ niche: "not_a_niche" }), /^That industry template has no design directions/, true],
    ["503 not_configured (route)", () => { delete process.env.GITPAGE_API_KEY; }, /^Website building is not set up/, false],
    ["502 upstream: gitpage 401 revoked key", () => { gitpage = () => Response.json({ error: "Invalid API key" }, { status: 401 }); }, /^The design service is unavailable right now\./, true],
    ["502 upstream: gitpage 403", () => { gitpage = () => Response.json({ message: "Key lacks scope" }, { status: 403 }); }, /^The design service is unavailable right now\./, true],
    ["502 upstream: gitpage 500", () => { gitpage = () => Response.json({ error: "boom stack trace" }, { status: 500 }); }, /^The design service is unavailable right now\./, true],
    ["502 upstream: gitpage unreachable", () => { gitpage = () => { throw new TypeError("fetch failed"); }; }, /^The design service is unavailable right now\./, true],
    ["429 from a limiter in front (no code)", () => { fetchMock.mockImplementationOnce(async () => new Response("Too Many Requests", { status: 429 })); }, /^Too many requests/, true],
    ["502 non-JSON from a proxy (no code)", () => { fetchMock.mockImplementationOnce(async () => new Response("<html>bad gateway</html>", { status: 502 })); }, /^The design service is unavailable right now\./, true],
    ["network error reaching our route", () => { fetchMock.mockImplementationOnce(async () => { throw new TypeError("Failed to fetch"); }); }, /^Could not reach the server/, true],
  ];

  it.each(cases)("%s", async (_n, arrange, text, fallback) => {
    const props = arrange() ?? {};
    const onChange = vi.fn();
    await mount({ ...props, value: null, onChange });
    expect(host.textContent).not.toContain("Loading design directions");
    const notice = host.querySelector(fallback ? '[role="status"]' : '[role="alert"]');
    expect(notice?.textContent).toMatch(text);
    expect(host.querySelector(fallback ? '[role="alert"]' : '[role="status"]')).toBeNull();
    expect(notice?.textContent?.includes("default direction")).toBe(fallback);
    // gitpage's own text never reaches the operator.
    expect(notice?.textContent).not.toMatch(/Invalid API key|Key lacks scope|boom stack trace/);
    expect(buttons()).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});
