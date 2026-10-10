// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { syntheticDefaultPipeline } from "@/lib/pipelines/stages";
import type { Deal, PipelineDoc } from "@/types/deals";

/**
 * The "Pipeline deal this quote is for" picker offers the contact's OPEN
 * deals, open meaning not on a won/lost stage of the deal's OWN pipeline,
 * each labelled from that pipeline.
 */

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
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({
    subAccountId: "sa1",
    subAccount: null,
    pipelines: [syntheticDefaultPipeline("sa1"), installs],
  }),
}));
vi.mock("@/lib/firestore/territories", () => ({ subscribeToTerritories: () => () => {} }));

const { QuoteBuilder } = await import("./quote-builder");

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const deal = (id: string, stageId: string, pipelineId?: string, contactId = "c1") =>
  ({ id, contactId, stageId, pipelineId, title: id, value: 1, currency: "ZAR" }) as Deal;

async function options(deals: Deal[]) {
  await act(async () =>
    root.render(
      createElement(QuoteBuilder, {
        contactName: "Ann",
        selectedContactId: "c1",
        products: [],
        deals,
        onSave: async () => undefined,
      }),
    ),
  );
  const select = container.querySelector<HTMLSelectElement>("#linked-deal");
  return select ? [...select.options].slice(1).map((o) => o.textContent ?? "") : [];
}

it("offers only open deals by each deal's own pipeline, with its labels", async () => {
  const opts = await options([
    deal("custom_won", "live", "installs"),
    deal("custom_signoff", "won", "installs"),
    deal("custom_booked", "booked", "installs"),
    deal("default_won", "won"),
    deal("default_lost", "lost"),
    deal("default_proposal", "proposal"),
    deal("other_contact", "booked", "installs", "c2"),
  ]);
  expect(opts.map((o) => o.split(" · ").slice(0, 2).join(" · "))).toEqual([
    "custom_signoff · Awaiting sign-off",
    "custom_booked · Booked",
    "default_proposal · Proposal",
  ]);
});

it("hides the picker when the contact's only deal is Won in a custom pipeline", async () => {
  expect(await options([deal("custom_won", "live", "installs")])).toEqual([]);
  expect(container.querySelector("#linked-deal")).toBeNull();
});
