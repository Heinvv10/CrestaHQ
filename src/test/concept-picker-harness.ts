import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";
import { ConceptPicker } from "@/components/website/website-premium-sections";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Shared harness for the ConceptPicker tests. The picker's fetch goes to the
 * REAL concepts route (real tenancy check, real gate, real gitpage client);
 * only gitpage itself is stubbed. So every error the picker sees is a body the
 * route actually produces, and a change to the route's codes breaks the tests.
 *
 * Each test file mocks "@/lib/firebase/admin" onto `mem` / `claims` (vi.mock
 * must be hoisted in the test file itself) and calls setupConceptPickerTests().
 */

export const mem = createMemoryFirestore();
export const claims: Record<string, Record<string, unknown>> = {
  u_member: { status: "active", agencyId: "ag1" },
};

const GITPAGE = "https://gitpage.test";
const card = (id: string, niche: string) => ({
  id, niche, name: `${id} name`, pitch: `${id} pitch`, fit: "Boutique gyms", archetype: "editorial",
  typeSystem: "serif_sans", defaultMode: "dark", modes: ["light", "dark"],
  accents: { light: "#111111", dark: "#222222" }, heroMotion: "still",
});
export const CARDS: Record<string, ReturnType<typeof card>[]> = {
  gym_fitness: [card("iron", "gym_fitness"), card("pulse", "gym_fitness")],
  home_services: [card("tradesman", "home_services")],
};

/** Mutable per-test state (reset in beforeEach). */
export const h = {
  /** What gitpage answers; defaults to the niche's cards. */
  gitpage: (() => Response.json({})) as (url: URL) => Response | Promise<Response>,
  /** Who is signed in when the picker calls the route (undefined = nobody). */
  uid: undefined as string | undefined,
  /** Route bodies the picker has finished reading (its next step is synchronous). */
  bodiesRead: 0,
  host: null as unknown as HTMLDivElement,
  root: null as unknown as Root,
};

async function callRoute(path: string): Promise<Response> {
  const { GET } = await import("@/app/api/sub-accounts/[id]/website/concepts/route");
  const id = decodeURIComponent(path.split("/")[3]);
  return GET(
    new Request(`https://app.test${path}`, { headers: h.uid ? { "x-user-uid": h.uid } : {} }),
    { params: Promise.resolve({ id }) },
  );
}

export const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
  const url = String(input);
  if (url.startsWith(GITPAGE)) return h.gitpage(new URL(url));
  const res = await callRoute(url);
  const json = res.json.bind(res);
  res.json = async () => {
    try {
      return await json();
    } finally {
      h.bodiesRead++;
    }
  };
  return res;
});

export const render = (el: React.ReactElement) => act(async () => h.root.render(el));
export const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
/**
 * Ticks until `cond` holds; throws rather than letting a test pass on a
 * timeout. Deadline-based: the route's first (cold) import can take seconds
 * on a loaded box.
 */
export async function until(cond: () => boolean, what: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await flush();
  }
}
export const loaded = () => until(() => !h.host.textContent?.includes("Loading design directions"), "the load to settle");
export const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);

export type PickerProps = { subAccountId?: string; niche?: string | null; value?: string | null; onChange?: (id: string | null) => void };
export const picker = (p: PickerProps = {}) =>
  createElement(ConceptPicker, {
    subAccountId: p.subAccountId ?? "sa1",
    niche: p.niche === undefined ? "gym_fitness" : p.niche,
    mode: "dark",
    value: p.value ?? null,
    onChange: p.onChange ?? (() => {}),
  });
export const mount = async (p: PickerProps = {}) => {
  await render(picker(p));
  await loaded();
};
export const buttons = () => Array.from(h.host.querySelectorAll("button"));
/** Unmount the picker and give the test a fresh root. */
export async function remount() {
  await act(async () => h.root.unmount());
  h.root = createRoot(h.host);
}

export function setupConceptPickerTests() {
  const original = { key: process.env.GITPAGE_API_KEY, url: process.env.GITPAGE_API_URL };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(console, "error").mockImplementation(() => {}); // the route logs gitpage failures
    process.env.GITPAGE_API_KEY = "gp_test_key";
    process.env.GITPAGE_API_URL = GITPAGE;
    mem.clear();
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme", websiteEnabledByAgency: true });
    mem.seed("subAccounts/sa2", { agencyId: "ag1", name: "Sibling", websiteEnabledByAgency: true });
    mem.seed("subAccounts/sa1/subAccountMembers/u_member", { role: "member", status: "active" });
    h.uid = "u_member";
    h.gitpage = (url) => Response.json({ concepts: CARDS[url.searchParams.get("niche") ?? ""] ?? [] });
    h.bodiesRead = 0;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    h.host = document.createElement("div");
    document.body.appendChild(h.host);
    h.root = createRoot(h.host);
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => {
    act(() => h.root.unmount());
    h.host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.off("unhandledRejection", onUnhandled);
    for (const [name, value] of [["GITPAGE_API_KEY", original.key], ["GITPAGE_API_URL", original.url]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}
