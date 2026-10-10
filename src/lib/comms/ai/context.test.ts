import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import type { Contact } from "@/types/contacts";

/**
 * The AI reply context resolves each deal's stage on ITS pipeline. A deal
 * Won in a custom pipeline must read as a past sale, never as an active deal
 * labelled with the default's first stage — this text reaches customers.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { buildContactContextBlock } = await import("./context");

const contact = { id: "c1", subAccountId: "sa1", name: "Ann" } as Contact;
const deal = (id: string, extra: Record<string, unknown>, minutesAgo: number) =>
  mem.seed(`deals/${id}`, {
    contactId: "c1",
    subAccountId: "sa1",
    value: 100,
    currency: "ZAR",
    updatedAt: new Date(Date.now() - minutesAgo * 60_000),
    ...extra,
  });

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("subAccounts/sa1/pipelines/installs", {
    name: "Installs",
    isDefault: false,
    stages: [
      { id: "booked", label: "Booked", tone: "" },
      { id: "live", label: "Live", tone: "", terminal: "won" },
      // An OPEN stage that happens to share the default's "won" id.
      { id: "won", label: "Awaiting sign-off", tone: "" },
    ],
  });
});

it("a custom-pipeline Won deal is a past sale, not an active deal", async () => {
  deal("d1", { title: "Fibre install", pipelineId: "installs", stageId: "live" }, 1);
  const block = await buildContactContextBlock(contact);
  expect(block).not.toContain("Active deals:");
  expect(block).toContain('Past sale: "Fibre install"');
});

it("custom-pipeline open deals carry their own pipeline's label", async () => {
  deal("d1", { title: "Router swap", pipelineId: "installs", stageId: "won" }, 1);
  deal("d2", { title: "Fibre 100", pipelineId: "installs", stageId: "booked" }, 2);
  const block = await buildContactContextBlock(contact);
  expect(block).toContain('"Router swap" — Awaiting sign-off');
  expect(block).toContain('"Fibre 100" — Booked');
  expect(block).not.toContain("Past sale");
});

it("default-pipeline deals still resolve by the default's stages", async () => {
  deal("d1", { title: "Old sale", stageId: "won" }, 1);
  deal("d2", { title: "Upgrade", stageId: "proposal" }, 2);
  const block = await buildContactContextBlock(contact);
  expect(block).toContain('"Upgrade" — Proposal');
  expect(block).not.toContain('"Old sale" —');
  expect(block).toContain('Past sale: "Old sale"');
});

it("a deal whose pipeline is gone is left out rather than guessed", async () => {
  deal("d1", { title: "Orphan", pipelineId: "deleted", stageId: "booked" }, 1);
  const block = await buildContactContextBlock(contact);
  expect(block ?? "").not.toContain("Orphan");
});
