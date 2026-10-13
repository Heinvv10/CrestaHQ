import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";
import { WebsiteWizard, type WizardStepId } from "@/components/website/website-wizard";
import { byLabel } from "@/test/dom-queries";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { blankWebsiteConfig, type WebsiteConfig, type WebsiteDoc } from "@/types/website";

/**
 * Shared harness for the website wizard's tests. The wizard's fetches go to
 * the REAL routes — the draft-save PATCH, the concepts proxy and the build
 * route, with their real tenancy checks, gate and state guards — over an
 * in-memory Firestore. Only gitpage itself is stubbed (plus QStash, the
 * heartbeat cache and the app-url probe, which the build route's own tests
 * cover). So a refusal the wizard shows is one the route actually produces.
 *
 * The test file mocks "@/lib/firebase/admin" onto `mem` / `claims`, the
 * build route's side modules, and "sonner" (vi.mock must be hoisted in the
 * test file itself), then calls setupWizardTests().
 */

export const mem = createMemoryFirestore();
export const claims: Record<string, Record<string, unknown>> = {
  u_admin: { status: "active", agencyId: "ag1" },
};
export const SITE = "subAccounts/sa1/website/site1";
const GITPAGE = "https://gitpage.test";

/** Every request the wizard made, in order: "METHOD path". */
export const calls: string[] = [];
/** Bodies gitpage received for builds. */
export const gitpageBuilds: Array<Record<string, unknown>> = [];
/** What gitpage answers a build with; null = an accepted build (202 + job id). */
export const gitpageAnswer = { build: null as null | (() => Response) };

async function callRoute(url: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? "GET";
  const path = url.split("?")[0];
  const [, , , id, , siteId, action] = path.split("/");
  const request = new Request(`https://app.test${url}`, {
    method,
    headers: { "content-type": "application/json", "x-user-uid": "u_admin" },
    body: init.body ?? undefined,
  });
  if (siteId === "concepts") {
    const { GET } = await import("@/app/api/sub-accounts/[id]/website/concepts/route");
    return GET(request, { params: Promise.resolve({ id }) });
  }
  if (action === "build") {
    const { POST } = await import("@/app/api/sub-accounts/[id]/website/[siteId]/build/route");
    return POST(request, { params: Promise.resolve({ id, siteId }) });
  }
  const { PATCH } = await import("@/app/api/sub-accounts/[id]/website/[siteId]/route");
  return PATCH(request, { params: Promise.resolve({ id, siteId }) });
}

export const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.startsWith(`${GITPAGE}/api/v1/concepts`)) return Response.json({ concepts: [] });
  if (url.startsWith(`${GITPAGE}/api/v1/generate-site`)) {
    gitpageBuilds.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (gitpageAnswer.build) return gitpageAnswer.build();
    return Response.json(
      { formResponseId: "build_new", pollUrl: `${GITPAGE}/s/build_new`, estimatedDurationSeconds: 1200 },
      { status: 202 },
    );
  }
  if (url.startsWith(GITPAGE)) return new Response("not stubbed", { status: 500 });
  calls.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`);
  pending++;
  try {
    const res = await callRoute(url, init);
    // Read here, so the wizard's own .json() cannot outlive `pending`.
    const body = await res.text();
    return new Response(body, { status: res.status, headers: res.headers });
  } finally {
    pending--;
  }
});
let pending = 0;

export const host = () => document.body;
export const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
/** Ticks until `cond` holds; throws rather than passing on a timeout. */
export async function until(cond: () => boolean, what: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await flush();
  }
}

export const stepText = () => host().querySelector("[data-slot=dialog-content] p")?.textContent ?? "";
export const title = () => host().querySelector("[data-slot=dialog-title]")?.textContent ?? "";
/** A button by its text, or by its aria-label when it has no text (the step dots). */
export const button = (text: string | RegExp) => {
  const name = (b: HTMLButtonElement) => b.textContent?.trim() || b.getAttribute("aria-label") || "";
  const hit = Array.from(host().querySelectorAll("button")).find((b) =>
    typeof text === "string" ? name(b) === text : text.test(name(b)),
  );
  if (!hit) throw new Error(`no button "${String(text)}"`);
  return hit;
};
export const hasButton = (text: string | RegExp) => {
  try {
    button(text);
    return true;
  } catch {
    return false;
  }
};
export const patches = () => calls.filter((c) => c.startsWith("PATCH "));
/** The stored site doc. */
export const site = () => mem.read(SITE) as unknown as WebsiteDoc;

/** Types into a labelled input the way React sees a keystroke. */
export async function type(label: string, value: string) {
  const el = byLabel(host(), label) as HTMLInputElement | HTMLTextAreaElement;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Toggles a labelled checkbox. */
export async function check(label: string) {
  const el = byLabel(host(), label);
  await act(async () => el.click());
}

/** Clicks and waits for any save or build the click started to finish. */
export async function click(text: string | RegExp) {
  const before = calls.length;
  await act(async () => button(text).click());
  await flush();
  if (calls.length > before) {
    await until(() => pending === 0, "the request to settle");
    await flush();
  }
}

let root: Root;
export const onOpenChange = vi.fn();

export function seedSite(patch: Partial<WebsiteDoc> = {}, config: Partial<WebsiteConfig> = {}) {
  mem.seed(SITE, {
    id: "site1",
    agencyId: "ag1",
    subAccountId: "sa1",
    status: "draft",
    gitpageJobId: null,
    liveUrl: null,
    wizardStep: null,
    config: { ...blankWebsiteConfig(), ...config },
    ...patch,
  });
}

/** Opens the wizard on the stored doc, as the card does. */
export async function openWizard(startAt: WizardStepId | null = null) {
  await act(async () =>
    root.render(createElement(WebsiteWizard, { open: true, onOpenChange, subAccountId: "sa1", doc: site(), startAt })),
  );
  await flush();
}

export function setupWizardTests() {
  const original = { key: process.env.GITPAGE_API_KEY, url: process.env.GITPAGE_API_URL };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // Base UI's checkbox reads PointerEvent, which jsdom does not ship.
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.stubGlobal("fetch", fetchMock);
    // jsdom has no Element#scrollTo; the wizard scrolls its body on each step.
    HTMLElement.prototype.scrollTo = () => {};
    process.env.GITPAGE_API_KEY = "gp_test_key";
    process.env.GITPAGE_API_URL = GITPAGE;
    mem.clear();
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme", websiteEnabledByAgency: true });
    mem.seed("subAccounts/sa1/subAccountMembers/u_admin", { role: "admin", status: "active" });
    calls.length = 0;
    pending = 0;
    gitpageBuilds.length = 0;
    gitpageAnswer.build = null;
    fetchMock.mockClear();
    onOpenChange.mockReset();
    root = createRoot(document.createElement("div"));
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
    for (const [name, value] of [["GITPAGE_API_KEY", original.key], ["GITPAGE_API_URL", original.url]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}
