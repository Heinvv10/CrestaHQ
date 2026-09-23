import { beforeEach, expect, it, vi } from "vitest";

/**
 * A contact created from an inbound WhatsApp opt-out (a never-seen number
 * whose message is STOP) is written opted out and announces nothing: a
 * `contact.created` workflow must never get the chance to message them.
 */

const m = vi.hoisted(() => ({ written: [] as Array<Record<string, unknown>> }));

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        id: "c_new",
        set: async (d: Record<string, unknown>) => {
          m.written.push(d);
        },
      }),
    }),
  }),
}));
vi.mock("@/lib/server/conversation-mirror", () => ({ mirrorContactAssignee: vi.fn() }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn() }));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn(async () => null) }));
vi.mock("@/lib/api/serializers/contacts", () => ({
  serializeContactForApi: (id: string) => ({ id }),
}));

import { createContactServerSide } from "./contacts-service";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";

const input = {
  subAccountId: "sa_1",
  agencyId: "ag_1",
  createdByUid: "whatsapp-cloud-inbound",
  mode: "live" as const,
  name: "",
  email: "",
  phone: "+27821234567",
  company: "",
  address: "",
  source: "whatsapp",
  tags: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  m.written.length = 0;
});

it("writes the contact opted out and fires no contact.created webhook or workflow", async () => {
  const res = await createContactServerSide({ ...input, optedOutOnWhatsapp: true });

  expect(res).toMatchObject({ id: "c_new", firedTrigger: false });
  expect(m.written).toEqual([expect.objectContaining({ whatsappOptedOut: true })]);
  expect(emitWebhookEvent).not.toHaveBeenCalled();
  expect(fireWorkflowTrigger).not.toHaveBeenCalled();
});

it("an ordinary new contact still announces itself", async () => {
  await createContactServerSide(input);

  expect(m.written[0]).not.toHaveProperty("whatsappOptedOut");
  expect(emitWebhookEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: "contact.created" })
  );
  expect(fireWorkflowTrigger).toHaveBeenCalledWith(
    expect.objectContaining({ type: "contact.created" })
  );
});
