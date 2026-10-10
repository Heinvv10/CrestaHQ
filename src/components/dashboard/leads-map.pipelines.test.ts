// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { syntheticDefaultPipeline } from "@/lib/pipelines/stages";
import type { Contact } from "@/types/contacts";
import type { Deal, PipelineDoc } from "@/types/deals";

/**
 * The leads map picks each contact's open deal first and labels it from the
 * deal's OWN pipeline. A deal Won in a custom pipeline is closed: it must
 * not beat an open deal, nor read as the default's first stage ("New").
 */

const sources: Array<{ features: Array<{ properties: Record<string, unknown> }> }> = [];
vi.mock("react-map-gl/mapbox", () => ({
  Map: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Source: ({ data, children }: { data: (typeof sources)[number]; children: ReactNode }) => {
    sources.push(data);
    return createElement("div", null, children);
  },
  Layer: () => null,
  Popup: () => null,
}));
vi.mock("mapbox-gl/dist/mapbox-gl.css", () => ({}));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const installs: PipelineDoc = {
  ...syntheticDefaultPipeline("sa1"),
  id: "installs",
  name: "Installs",
  isDefault: false,
  stages: [
    { id: "booked", label: "Booked", tone: "t-booked" },
    { id: "live", label: "Live", tone: "t-live", terminal: "won" },
    { id: "won", label: "Awaiting sign-off", tone: "t-signoff" },
  ],
};
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({
    saPath: (p: string) => `/sa/sa1${p}`,
    pipelines: [syntheticDefaultPipeline("sa1"), installs],
  }),
}));

const { LeadsMap } = await import("./leads-map");

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "pk.test");
  sources.length = 0;
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const contact = (id: string) => ({ id, name: id, lat: 1, lng: 1 }) as unknown as Contact;
const deal = (id: string, contactId: string, stageId: string, pipelineId?: string) =>
  ({ id, contactId, stageId, pipelineId, title: id, value: 1, currency: "ZAR" }) as Deal;

async function features(deals: Deal[], contacts: Contact[]) {
  await act(async () => root.render(createElement(LeadsMap, { contacts, deals })));
  const last = sources.at(-1)!;
  return Object.fromEntries(last.features.map((f) => [f.properties.contactId, f.properties]));
}

it("an open deal beats a custom-pipeline Won deal listed before it", async () => {
  const byContact = await features(
    [deal("d_live", "c1", "live", "installs"), deal("d_open", "c1", "booked", "installs")],
    [contact("c1")],
  );
  expect(byContact.c1).toMatchObject({ dealStageLabel: "Booked", dealStageTone: "t-booked" });
});

it("an OPEN custom stage with the id 'won' is open and keeps its own label", async () => {
  const byContact = await features(
    [deal("d_default_won", "c1", "won"), deal("d_signoff", "c1", "won", "installs")],
    [contact("c1")],
  );
  expect(byContact.c1).toMatchObject({ dealStageLabel: "Awaiting sign-off" });
});

it("a lone closed custom deal is labelled from its pipeline, not 'New'", async () => {
  const byContact = await features([deal("d_live", "c1", "live", "installs")], [contact("c1")]);
  expect(byContact.c1).toMatchObject({ dealStageLabel: "Live" });
});

it("a deal whose pipeline is gone shows its raw stage id with no stage colour", async () => {
  const byContact = await features([deal("d_orphan", "c1", "won", "deleted")], [contact("c1")]);
  expect(byContact.c1).toMatchObject({ dealStageLabel: "won", dealStageTone: null });
});
