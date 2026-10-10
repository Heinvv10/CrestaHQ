// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Style picker in the checkout-page editor. A new page starts on the
 * default preset; a page saved before presets existed keeps none until one
 * is picked, so saving any other field never restyles it.
 */

// One object per hook for the whole run: the page's effects depend on them,
// and a fresh object per render would re-subscribe forever.
const fx = vi.hoisted(() => ({
  pages: [] as Record<string, unknown>[],
  products: [{ id: "main", name: "Main", active: true, unitPriceCents: 4900, currency: "USD" }],
  auth: { user: { uid: "u1" }, loading: false },
  sub: {
    subAccountId: "sa1",
    subAccount: { agencyId: "ag1", paymentsEnabledByAgency: true, stripeConnectionMeta: { ready: true } },
    isAdmin: true,
    saPath: (p: string) => `/sa/sa1${p}`,
    loading: false,
  },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => fx.auth }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => fx.sub }));
vi.mock("@/lib/firestore/products", () => ({
  subscribeToProducts: (_scope: unknown, cb: (p: unknown[]) => void) => (cb(fx.products), () => {}),
}));
vi.mock("@/lib/firestore/checkout-pages", () => ({
  subscribeToCheckoutPages: (_sa: string, cb: (p: unknown[]) => void) => (cb(fx.pages), () => {}),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const { default: CheckoutPagesPage } = await import("./page");

let root: Root;
let container: HTMLDivElement;
const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true, id: "p1" }));

const page = (themePreset?: unknown) => ({
  id: "p1",
  name: "Offer",
  slug: "offer",
  status: "draft",
  productId: "main",
  bumpProductIds: [],
  headline: "",
  subheadline: "",
  successUrl: null,
  appearance: { theme: "light", accent: "#7c3aed", hideChrome: false, hideTitle: false },
  ...(themePreset === undefined ? {} : { themePreset }),
});

const buttons = () => [...container.querySelectorAll("button")];
const button = (label: string) => buttons().find((b) => b.textContent?.trim().startsWith(label))!;
const chosen = () =>
  [...container.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent?.replace(/(Brand default|Clean|Midnight|Noir Lime|Sunset|Ocean).*/, "$1"));

async function open(stored: Record<string, unknown> | null) {
  fx.pages = stored ? [stored] : [];
  await act(async () => root.render(createElement(CheckoutPagesPage)));
  await act(async () => button(stored ? "Edit" : "New page").click());
}

/** Saves the editor's form and returns the request it made. */
async function save(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
  fetchMock.mockClear();
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  return { url, method: String(init.method), body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("checkout page editor style preset", () => {
  it("a new page starts on the default preset, with no way to clear it", async () => {
    await open(null);
    expect(chosen()).toEqual(["Clean"]);
    expect(container.textContent).not.toContain("Brand default");
  });

  it("a page saved before presets opens with none chosen, and saving it sends none", async () => {
    await open(page());
    expect(chosen()).toEqual(["Brand default"]);
    const req = await save();
    expect(req).toMatchObject({ method: "PATCH", url: "/api/sub-accounts/sa1/checkout-pages/p1" });
    expect(req.body.themePreset).toBeNull();
  });

  it("sends the preset picked for such a page", async () => {
    await open(page());
    await act(async () => button("Sunset").click());
    expect(chosen()).toEqual(["Sunset"]);
    expect((await save()).body.themePreset).toBe("sunset");
  });

  it("opens on the stored preset, sends it back, and no longer offers to clear it", async () => {
    await open(page("midnight"));
    expect(chosen()).toEqual(["Midnight"]);
    expect(container.textContent).not.toContain("Brand default");
    expect((await save()).body.themePreset).toBe("midnight");
  });

  it("opens an unrecognised stored preset as none", async () => {
    await open(page("bogus"));
    expect(chosen()).toEqual(["Brand default"]);
    expect((await save()).body.themePreset).toBeNull();
  });
});
