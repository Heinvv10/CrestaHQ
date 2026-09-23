import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { defaultFormSettings } from "@/types/forms";

/**
 * A public form submit is unauthenticated: anyone can type any email. When
 * it matches an EXISTING contact, the submitted channel fields (phone /
 * email) must NOT be written onto that contact — otherwise a stranger who
 * knows a customer's email can route that customer's future SMS/WhatsApp
 * to their own number. The values stay on the submission + activity so
 * staff can see and verify them. Real route over an in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));
vi.mock("@/lib/forms/spam-guard", () => ({
  checkFormSpam: () => ({ kind: "ok" }),
  ELAPSED_BODY_KEY: "_elapsed",
  HONEYPOT_BODY_KEY: "_hp",
}));

const { POST } = await import("./route");

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("forms/f1", {
    name: "Contact", slug: "contact", enabled: true, submissionCount: 0,
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u_owner",
    fields: [
      { id: "name", type: "text", label: "Name", required: false, mapsTo: "name" },
      { id: "email", type: "email", label: "Email", required: false, mapsTo: "email" },
      { id: "phone", type: "phone", label: "Phone", required: false, mapsTo: "phone" },
    ],
    settings: { ...defaultFormSettings(), createDeal: false },
  });
});

function submit(values: Record<string, string>) {
  return POST(
    new Request("http://x/api/forms/f1/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values }),
    }),
    { params: Promise.resolve({ id: "f1" }) },
  );
}

it("known email + new phone: existing contact's blank phone stays blank; submission + activity carry it", async () => {
  mem.seed("contacts/victim", {
    subAccountId: "sa1", agencyId: "ag1", name: "Naledi",
    email: "naledi@example.com", phone: "",
  });
  const res = await submit({ name: "Naledi", email: "naledi@example.com", phone: "+27821234567" });
  const body = (await res.json()) as { contactId: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  expect(body.contactId).toBe("victim");

  expect(mem.read("contacts/victim")?.phone).toBe("");
  const [submission] = mem.list("forms/f1/submissions");
  expect(submission).toMatchObject({ contactId: "victim", values: { phone: "+27821234567" } });
  const [activity] = mem.list("contacts/victim/activities");
  expect(activity).toMatchObject({
    type: "form_submitted",
    content: 'Submitted form "Contact" — unverified phone +27821234567 (not saved to contact)',
  });
});

it("known phone + new email: existing contact's blank email stays blank", async () => {
  mem.seed("contacts/victim", {
    subAccountId: "sa1", agencyId: "ag1", name: "Naledi",
    email: "", phone: "+27821234567",
  });
  const res = await submit({ email: "someone@else.test", phone: "+27821234567" });
  expect(res.status).toBe(200);
  expect(mem.read("contacts/victim")?.email).toBe("");
});

it("a brand-new visitor still becomes a contact with the submitted phone + email", async () => {
  const res = await submit({ name: "Thandi", email: "thandi@example.com", phone: "+27829876543" });
  const body = (await res.json()) as { contactId: string };
  expect(res.status).toBe(200);
  expect(mem.read(`contacts/${body.contactId}`)).toMatchObject({
    email: "thandi@example.com", phone: "+27829876543",
  });
});
