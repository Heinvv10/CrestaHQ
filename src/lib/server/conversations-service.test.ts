import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  contact: {
    subAccountId: "sa",
    agencyId: "agency",
    territoryId: "private",
  } as Record<string, unknown>,
  writes: vi.fn(),
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({ path }),
    collection: (path: string) => ({
      doc: (id: string) => ({ path: `${path}/${id}` }),
    }),
    runTransaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        get: async (ref: { path: string }) => ({
          exists: ref.path.startsWith("contacts/"),
          data: () =>
            ref.path.startsWith("contacts/") ? m.contact : undefined,
        }),
        set: m.writes,
      }),
  }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn() }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: vi.fn(),
  resumeWaitingRunsOnReply: vi.fn(),
}));
import {
  upsertConversationForMessage,
  setConversationDraft,
} from "./conversations-service";
const input = {
  contactId: "contact",
  subAccountId: "sa",
  agencyId: "agency",
  contactName: "Name",
  contactPhone: null,
  channel: "sms" as const,
  direction: "outbound" as const,
  body: "Hello",
};
beforeEach(() => {
  vi.clearAllMocks();
  m.contact = {
    subAccountId: "sa",
    agencyId: "agency",
    territoryId: "private",
  };
});
it("copies the authoritative contact territory for every channel", async () => {
  await upsertConversationForMessage(input);
  expect(m.writes).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ territoryId: "private" }),
    expect.anything()
  );
});
it("applies contact territory to suggestion drafts", async () => {
  await setConversationDraft({ ...input, model: "model", tokens: 1 });
  expect(m.writes).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ territoryId: "private" }),
    expect.anything()
  );
});
it("does not write cross-tenant contact previews", async () => {
  m.contact.subAccountId = "foreign";
  await upsertConversationForMessage(input);
  expect(m.writes).not.toHaveBeenCalled();
});
