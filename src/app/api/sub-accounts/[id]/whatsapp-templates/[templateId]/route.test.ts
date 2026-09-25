import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A template whose flat (Twilio) status is editable can still be approved or
 * pending on another rail — or on Twilio through an explicit registration —
 * which sends its stored content. Its text, buttons and language must not
 * change under it; its display name and variables may.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({ requireSubAccountAdmin: async () => ({ uid: "u_1" }) }));

const { PATCH } = await import("@/app/api/sub-accounts/[id]/whatsapp-templates/[templateId]/route");

const PATH = "subAccounts/sa_1/whatsappTemplates/t1";
const BASE = {
  subAccountId: "sa_1", agencyId: "ag_1", name: "install_day", displayName: "Install day", category: "UTILITY", language: "en",
  body: "Hi {{1}}.", variables: [{ position: 1, label: "First name", sampleValue: "Ben", source: "merge_tag", mergeTag: "contact.firstName" }],
  status: "rejected", contentSid: null, rejectionReason: "Meta said no",
};
const edit = (patch: Record<string, unknown>) =>
  PATCH(new Request("https://app.test/x", { method: "PATCH", body: JSON.stringify(patch) }), {
    params: Promise.resolve({ id: "sa_1", templateId: "t1" }),
  });

beforeEach(() => mem.clear());

describe("editing a template live on some rail", () => {
  it.each([
    ["approved", "twilio", { twilio: { externalId: "HX1", status: "approved", rejectionReason: null } }],
    ["pending", "cloud", { cloud: { externalId: "meta_1", status: "pending", rejectionReason: null } }],
    ["approved", "bridge", { bridge: { externalId: "b1", status: "approved", rejectionReason: null } }],
  ])("%s on %s: text, buttons and language are refused (409), the doc unchanged", async (status, rail, registrations) => {
    mem.seed(PATH, { ...BASE, registrations });
    for (const patch of [{ body: "Hi {{1}}, it changed." }, { buttons: [{ type: "quick_reply", text: "YES" }] }, { language: "af" }]) {
      const res = await edit(patch);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(
        `This template is ${status} on ${rail}, so its text, buttons and language can't change. Create a new template instead.`
      );
    }
    expect(mem.read(PATH)).toEqual({ ...BASE, registrations });
  });

  it("the display name can still change", async () => {
    mem.seed(PATH, { ...BASE, registrations: { twilio: { externalId: "HX1", status: "approved", rejectionReason: null } } });
    expect((await edit({ displayName: "Install day v2" })).status).toBe(200);
    expect(mem.read(PATH)).toMatchObject({ displayName: "Install day v2", body: "Hi {{1}}." });
  });

  it("with nothing approved or pending on any rail, the text is editable as before", async () => {
    mem.seed(PATH, { ...BASE, registrations: { cloud: { externalId: null, status: "rejected", rejectionReason: "no" } } });
    expect((await edit({ body: "Hi {{1}}, it changed.", language: "af" })).status).toBe(200);
    expect(mem.read(PATH)).toMatchObject({ body: "Hi {{1}}, it changed.", language: "af", status: "draft" });
  });
});
