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
const loadKeys = vi.hoisted(() => vi.fn(async () => new Set<string>()));
const createContent = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ contentSid: "HX2" })));
vi.mock("@/lib/custom-fields/load-defs", () => ({ loadContactCustomFieldKeys: loadKeys }));
vi.mock("@/lib/comms/whatsapp/templates-api", async (orig) => ({
  ...((await orig()) as object), createContentTemplate: createContent, submitForWhatsappApproval: async () => undefined,
}));
vi.mock("@/lib/server/sub-account-secrets", () => ({ readSubAccountSecret: async () => "tok" }));
vi.mock("@/lib/automations/qstash", () => ({ qstashIsConfigured: () => false, publishCallback: async () => null }));

const { PATCH } = await import("@/app/api/sub-accounts/[id]/whatsapp-templates/[templateId]/route");
const { POST: SUBMIT } = await import("@/app/api/sub-accounts/[id]/whatsapp-templates/[templateId]/submit/route");

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

const submit = () =>
  SUBMIT(new Request("https://app.test/x", { method: "POST" }), { params: Promise.resolve({ id: "sa_1", templateId: "t1" }) });

beforeEach(() => {
  mem.clear();
  loadKeys.mockClear();
  createContent.mockClear();
  mem.seed("subAccounts/sa_1", {
    agencyId: "ag_1", whatsappEnabledByAgency: true, whatsappProvider: "twilio",
    twilioConfig: { enabled: true, accountSid: "AC1", authToken: "tok", whatsappFromNumber: "+27110000000" },
  });
});

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

  it("the manager's full save payload with only the name changed goes through (buttons compared canonically)", async () => {
    // Stored with a different key order than the manager sends.
    const buttons = [{ url: "https://x.io/r", text: "Reschedule", type: "url" }];
    mem.seed(PATH, { ...BASE, buttons, registrations: { twilio: { externalId: "HX1", status: "approved", rejectionReason: null } } });
    const res = await edit({
      displayName: "Install day v2", category: "UTILITY", language: " en ", body: " Hi {{1}}. ", variables: BASE.variables,
      buttons: [{ type: "url", text: "Reschedule", url: "https://x.io/r" }],
    });
    expect(res.status).toBe(200);
    expect(mem.read(PATH)).toMatchObject({ displayName: "Install day v2", body: "Hi {{1}}.", language: "en" });
  });

  it("with nothing approved or pending on any rail, the text is editable as before", async () => {
    mem.seed(PATH, { ...BASE, registrations: { cloud: { externalId: null, status: "rejected", rejectionReason: "no" } } });
    expect((await edit({ body: "Hi {{1}}, it changed.", language: "af" })).status).toBe(200);
    expect(mem.read(PATH)).toMatchObject({ body: "Hi {{1}}, it changed.", language: "af", status: "draft" });
  });
});

describe("an edit and a submit racing", () => {
  it("the edit read before the submit, and writes after it → 409, the submitted content stands", async () => {
    mem.seed(PATH, { ...BASE, status: "draft" });
    let submitted: Response | undefined;
    // Between the edit's read and its write, a whole submit runs.
    loadKeys.mockImplementationOnce(async () => {
      submitted = await submit();
      return new Set<string>();
    });
    const res = await edit({ body: "Hi {{1}}, it changed." });
    expect(submitted!.status).toBe(200);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("The template changed while saving. Reload and try again.");
    expect((createContent.mock.calls[0]![0] as { body: string }).body).toBe("Hi {{1}}.");
    expect(mem.read(PATH)).toMatchObject({ body: "Hi {{1}}.", status: "pending", contentSid: "HX2" });
  });

  it("the submit read before an edit, and writes after it → 409, nothing sent to the provider, the edit stands", async () => {
    mem.seed(PATH, { ...BASE, status: "draft" });
    const doc = mem.db.doc.bind(mem.db);
    vi.spyOn(mem.db, "doc").mockImplementationOnce((path: string) => {
      const ref = doc(path);
      return {
        ...ref,
        get: async () => {
          const snap = await ref.get();
          expect((await edit({ body: "Hi {{1}}, it changed." })).status).toBe(200);
          return snap;
        },
      };
    });
    const res = await submit();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("The template changed while saving. Reload and try again.");
    expect(createContent).not.toHaveBeenCalled();
    expect(mem.read(PATH)).toMatchObject({ body: "Hi {{1}}, it changed.", status: "draft" });
  });
});
