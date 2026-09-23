import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The web-chat capture wrapper records whether the linked contact was
 * CREATED by this session (visitor-supplied data only) or matched an
 * existing contact on a claimed email — respond.ts only gives the bot
 * contact context in the first case. Real wrapper + real reconciler +
 * real session link over an in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/server/contacts-service", () => ({
  emitContactCreatedById: async () => undefined,
}));

const { reconcileContactFromCapture } = await import("./capture");

const SESSION = "subAccounts/sa1/webChatSessions/sess_1";

function reconcile(email: string, phone: string | null, existingContactId: string | null = null) {
  return reconcileContactFromCapture({
    agencyId: "ag1", subAccountId: "sa1", sessionId: "sess_1",
    existingContactId, pageUrl: null,
    capture: { name: "Visitor", email, phone },
  });
}

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", defaultPhoneCountry: "ZA" });
  mem.seed(SESSION, { contactId: null });
});

it("claimed email of an existing contact: linked, flagged not-created, phone not written", async () => {
  mem.seed("contacts/victim", {
    subAccountId: "sa1", agencyId: "ag1", name: "Naledi",
    email: "naledi@example.com", phone: "",
  });
  const res = await reconcile("naledi@example.com", "+27821234567");
  expect(res).toEqual({ contactId: "victim", created: false });
  expect(mem.read(SESSION)).toMatchObject({
    contactId: "victim", contactCreatedBySession: false, capturedPhone: "+27821234567",
  });
  expect(mem.read("contacts/victim")?.phone).toBe("");
});

it("a new visitor: contact created, session flagged created", async () => {
  const res = await reconcile("new@example.com", null);
  expect(res?.created).toBe(true);
  expect(mem.read(SESSION)).toMatchObject({ contactId: res?.contactId, contactCreatedBySession: true });
});

it("a re-link of an already-linked session keeps the original flag", async () => {
  mem.seed(SESSION, { contactId: "c1", contactCreatedBySession: true });
  await reconcile("new@example.com", null, "c1");
  expect(mem.read(SESSION)?.contactCreatedBySession).toBe(true);
});
