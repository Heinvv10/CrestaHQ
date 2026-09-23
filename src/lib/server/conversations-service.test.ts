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
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import {
  fireWorkflowTrigger,
  resumeWaitingRunsOnReply,
} from "@/lib/workflows/engine";
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
// SP2 T1/I9 — every SMS/WhatsApp/Meta/web-chat message re-stamps the owner +
// email mirror from the contact (the source of truth).
it("mirrors the contact's owner and email onto the conversation", async () => {
  m.contact = { ...m.contact, assignedToUid: "u-owner", email: "a@b.co" };
  await upsertConversationForMessage(input);
  expect(m.writes).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ assigneeUid: "u-owner", contactEmail: "a@b.co" }),
    expect.anything()
  );
});
it("does not stamp a null owner over the mirror on create", async () => {
  // The fake conversation doc does not exist → this is the create branch.
  m.contact = { ...m.contact, assignedToUid: "u-owner" };
  await upsertConversationForMessage(input);
  expect(m.writes.mock.calls[0][1].assigneeUid).toBe("u-owner");
});
it("an anonymous web-chat row starts with an empty mirror", async () => {
  await upsertConversationForMessage({
    ...input,
    contactId: null,
    conversationKey: "web_s1",
    channel: "web-chat",
  });
  expect(m.writes).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ assigneeUid: null, contactEmail: null }),
    expect.anything()
  );
});
// An opt-out keyword is applied by the caller AFTER this call, so a workflow
// started here would race it — a message.received workflow could text someone
// whose message was STOP. The webhook still fires: it drives the staff push,
// and an opting-out customer must not go silently dark.
it("an inbound opt-out keyword notifies staff but starts no workflow", async () => {
  await upsertConversationForMessage({
    ...input,
    direction: "inbound",
    body: "STOP",
    optOut: true,
  });
  expect(m.writes).toHaveBeenCalled();
  expect(emitWebhookEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: "message.received" })
  );
  expect(resumeWaitingRunsOnReply).not.toHaveBeenCalled();
  expect(fireWorkflowTrigger).not.toHaveBeenCalled();
});
it("an ordinary inbound still fires message.received automation", async () => {
  await upsertConversationForMessage({ ...input, direction: "inbound" });
  expect(emitWebhookEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: "message.received" })
  );
  expect(resumeWaitingRunsOnReply).toHaveBeenCalled();
  expect(fireWorkflowTrigger).toHaveBeenCalledWith(
    expect.objectContaining({ type: "message.received" })
  );
});
