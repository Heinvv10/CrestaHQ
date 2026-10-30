// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CUSTOM_BRAND } from "@/config/landing";

/**
 * useAgency seeds from the server-read branding (AgencyBrandingProvider) so
 * the first paint — server markup AND the client's first render, which must
 * match for hydration — already carries the agency's name/logo/theme. The
 * live onSnapshot still owns every later update, and `loading` still means
 * "the full doc has resolved" (the Branding form and AI Suite gate on it).
 */
type Snap = { exists: () => boolean; data: () => Record<string, unknown> };
const m = vi.hoisted(() => ({
  auth: { agencyId: null as string | null, loading: true },
  onSnap: null as ((s: Snap) => void) | null,
  onErr: null as (() => void) | null,
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => m.auth }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, path: string) => ({ path }),
  onSnapshot: (_ref: unknown, next: (s: Snap) => void, err: () => void) => {
    m.onSnap = next;
    m.onErr = err;
    return () => undefined;
  },
}));

import { useAgency } from "./use-agency";
import { AgencyBrandingProvider, type AgencyBranding } from "@/context/agency-branding-context";

type Summary = ReturnType<typeof useAgency>;
let renders: Summary[] = [];
function Probe() {
  const a = useAgency();
  renders.push(a);
  return createElement("span", null, `${a.name}|${a.logoUrl ?? ""}|${a.appTheme ?? ""}`);
}
const SEED: AgencyBranding = {
  name: "Acme Agency",
  logoUrl: "https://cdn.example/l.png",
  appTheme: "green",
};
function tree(seed: AgencyBranding | null) {
  // children goes as the third argument; the cast satisfies the props type.
  const props = { initial: seed } as Parameters<typeof AgencyBrandingProvider>[0];
  return createElement(AgencyBrandingProvider, props, createElement(Probe));
}

let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  m.auth = { agencyId: null, loading: true };
  m.onSnap = null;
  m.onErr = null;
  renders = [];
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("server markup already carries the seeded branding", () => {
  expect(renderToString(tree(SEED))).toContain(
    "Acme Agency|https://cdn.example/l.png|green",
  );
});

it("the client's first render uses the seed (matching the server markup)", async () => {
  await act(async () => root.render(tree(SEED)));
  expect(renders[0]).toMatchObject({ ...SEED, brandingReady: true });
});

it("a seed does not claim the full doc has loaded", async () => {
  m.auth = { agencyId: "ag1", loading: false };
  await act(async () => root.render(tree(SEED)));
  expect(renders[0].loading).toBe(true);
  expect(renders[0].supportEmail).toBeNull();
});

it("the live snapshot still overrides the seed", async () => {
  m.auth = { agencyId: "ag1", loading: false };
  await act(async () => root.render(tree(SEED)));
  await act(async () =>
    m.onSnap!({
      exists: () => true,
      data: () => ({ name: "Renamed", logoUrl: null, appTheme: "neutral", supportEmail: "a@b.c" }),
    }),
  );
  expect(renders.at(-1)).toMatchObject({
    name: "Renamed",
    logoUrl: null,
    appTheme: "neutral",
    supportEmail: "a@b.c",
    loading: false,
    brandingReady: true,
  });
});

it("unseeded: defaults as before, and branding is not ready until the snapshot lands", async () => {
  await act(async () => root.render(tree(null)));
  expect(renders[0]).toMatchObject({
    name: CUSTOM_BRAND.name,
    logoUrl: null,
    appTheme: null,
    brandingReady: false,
  });

  m.auth = { agencyId: "ag1", loading: false };
  await act(async () => root.render(tree(null)));
  expect(renders.at(-1)!.brandingReady).toBe(false);
  await act(async () =>
    m.onSnap!({ exists: () => true, data: () => ({ name: "Acme Agency" }) }),
  );
  expect(renders.at(-1)).toMatchObject({ name: "Acme Agency", brandingReady: true });
});

it("unseeded with no agency at all: branding is ready once auth settles", async () => {
  m.auth = { agencyId: null, loading: false };
  await act(async () => root.render(tree(null)));
  expect(renders.at(-1)!.brandingReady).toBe(true);
});

it("works with no provider mounted (non-dashboard routes)", async () => {
  await act(async () => root.render(createElement(Probe)));
  expect(renders[0].name).toBe(CUSTOM_BRAND.name);
});

/**
 * `resolved`: the doc's settings (agentApiEnabled & co.) are the agency's
 * real values, not the defaults. On a hard load auth settles after mount,
 * so `loading` reads false before the doc arrives; `resolved` does not.
 */
it("hard load: not resolved until the snapshot lands, even with a seed and loading false", async () => {
  await act(async () => root.render(tree(SEED)));
  expect(renders.at(-1)!.resolved).toBe(false);
  m.auth = { agencyId: "ag1", loading: false };
  await act(async () => root.render(tree(SEED)));
  expect(renders.at(-1)).toMatchObject({ loading: false, resolved: false, agentApiEnabled: false });
  await act(async () => m.onSnap!({ exists: () => true, data: () => ({ agentApiEnabled: true }) }));
  expect(renders.at(-1)).toMatchObject({ resolved: true, agentApiEnabled: true });
});

it("a snapshot error resolves it with the defaults (switch reads off)", async () => {
  m.auth = { agencyId: "ag1", loading: false };
  await act(async () => root.render(tree(null)));
  expect(renders.at(-1)!.resolved).toBe(false);
  await act(async () => m.onErr!());
  expect(renders.at(-1)).toMatchObject({ resolved: true, agentApiEnabled: false });
});

it("no agency: resolved once auth settles", async () => {
  await act(async () => root.render(tree(null)));
  expect(renders.at(-1)!.resolved).toBe(false);
  m.auth = { agencyId: null, loading: false };
  await act(async () => root.render(tree(null)));
  expect(renders.at(-1)!.resolved).toBe(true);
});
