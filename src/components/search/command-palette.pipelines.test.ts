// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { syntheticDefaultPipeline } from "@/lib/pipelines/stages";
import type { Deal, PipelineDoc } from "@/types/deals";

/**
 * Cmd+K deal rows carry the stage label from the deal's OWN pipeline. The
 * palette renders above SubAccountProvider, so it loads pipelines itself;
 * until they arrive (or if the load fails) a row shows its raw stage id,
 * never the default pipeline's first stage.
 */

const state = vi.hoisted(() => ({
  deals: [] as Deal[],
  pipelines: Promise.resolve([]) as Promise<PipelineDoc[]>,
  fetched: [] as string[],
  user: { uid: "u1" },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/hooks/use-active-sub-account-id", () => ({
  useActiveSubAccountId: () => ({ subAccountId: "sa1", agencyId: "ag1" }),
}));
vi.mock("@/hooks/use-effective-territory-filter", () => ({
  useEffectiveTerritoryFilter: () => ({ ready: true, filter: null }),
}));
const none = () => () => {};
vi.mock("@/lib/firestore/contacts", () => ({ subscribeToContacts: none }));
vi.mock("@/lib/firestore/tasks", () => ({ subscribeToTasks: none }));
vi.mock("@/lib/firestore/events", () => ({ subscribeToEvents: none }));
vi.mock("@/lib/firestore/forms", () => ({ subscribeToForms: none }));
vi.mock("@/lib/firestore/deals", () => ({
  subscribeToDeals: (_s: unknown, _o: unknown, next: (d: Deal[]) => void) => {
    next(state.deals);
    return () => {};
  },
}));
vi.mock("@/lib/pipelines/client", () => ({
  fetchPipelines: (id: string) => {
    state.fetched.push(id);
    return state.pipelines;
  },
}));

const { CommandPalette } = await import("./command-palette");

const installs: PipelineDoc = {
  ...syntheticDefaultPipeline("sa1"),
  id: "installs",
  name: "Installs",
  isDefault: false,
  stages: [
    { id: "booked", label: "Booked", tone: "" },
    { id: "live", label: "Live", tone: "", terminal: "won" },
    { id: "won", label: "Awaiting sign-off", tone: "" },
  ],
};
const deal = (id: string, stageId: string, pipelineId?: string) =>
  ({ id, contactId: "c1", stageId, pipelineId, title: id, value: 1, currency: "ZAR" }) as Deal;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.fetched = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function dealSubtitles() {
  await act(async () =>
    root.render(createElement(CommandPalette, { open: true, onOpenChange: () => {} })),
  );
  return Object.fromEntries(
    [...document.body.querySelectorAll("p.truncate.font-medium")].map((p) => [
      p.textContent,
      p.nextElementSibling?.textContent?.split(" · ")[0],
    ]),
  );
}

it("labels each deal from its own pipeline", async () => {
  state.deals = [deal("custom_live", "live", "installs"), deal("custom_signoff", "won", "installs"), deal("default_won", "won")];
  state.pipelines = Promise.resolve([syntheticDefaultPipeline("sa1"), installs]);
  expect(await dealSubtitles()).toEqual({
    custom_live: "Live",
    custom_signoff: "Awaiting sign-off",
    default_won: "Won",
  });
  expect(state.fetched).toEqual(["sa1"]);
});

it("a failed pipelines load shows raw stage ids, not the default's 'New'", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  state.deals = [deal("custom_live", "live", "installs")];
  state.pipelines = Promise.reject(new Error("HTTP 500"));
  expect(await dealSubtitles()).toEqual({ custom_live: "live" });
  expect(err).toHaveBeenCalledWith("[command-palette] pipelines load failed", expect.any(Error));
  err.mockRestore();
});
