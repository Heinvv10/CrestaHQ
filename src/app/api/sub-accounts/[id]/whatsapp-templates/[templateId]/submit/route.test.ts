import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which rail a template is submitted for approval on.
 *
 * Approval belongs to a WABA, so it has to be requested on the rail the sends
 * will go out on. This route used to read `sub.whatsappProvider` directly
 * while dispatch resolved the sender registry — and nothing writes
 * `whatsappProvider` when an operator changes the default sender, so the two
 * silently diverged: the template is approved on Twilio's WABA and the send
 * goes out over Meta Cloud, failing at Meta with the customer unreachable.
 */

const SUB = "sa_1";
const TPL = "tpl_1";

let docs: Map<string, Record<string, unknown>>;
const createCloudTemplate = vi.fn();
const createContentTemplate = vi.fn();
const submitForWhatsappApproval = vi.fn();

function docRef(path: string) {
  return {
    get: async () => ({
      exists: docs.has(path),
      data: () => docs.get(path),
      id: path.split("/").pop(),
    }),
    update: async (data: Record<string, unknown>) => {
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
  };
}

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({ doc: docRef }),
  getAdminAuth: () => ({
    getUser: async () => ({
      customClaims: { status: "active", agencyId: "ag_1", agencyRole: null },
    }),
  }),
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));
vi.mock("@/lib/comms/whatsapp/cloud-credentials", () => ({
  getWabaCreds: async () => ({
    phoneNumberId: "pn_1",
    wabaId: "waba_1",
    accessToken: "tok",
  }),
}));
vi.mock("@/lib/comms/whatsapp/cloud-templates", () => ({
  createCloudTemplate: (...a: unknown[]) => createCloudTemplate(...a),
  CloudTemplateError: class extends Error {},
}));
vi.mock("@/lib/comms/whatsapp/templates-api", () => ({
  createContentTemplate: (...a: unknown[]) => createContentTemplate(...a),
  submitForWhatsappApproval: (...a: unknown[]) => submitForWhatsappApproval(...a),
  WhatsappContentError: class extends Error {},
}));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => false,
  publishCallback: async () => {},
}));
vi.mock("@/lib/comms/twilio", () => ({
  subAccountWhatsappIsConfigured: () => true,
}));

import { POST } from "./route";

const TWILIO_CONFIG = {
  enabled: true,
  accountSid: "AC1",
  authToken: "tok",
  whatsappFromNumber: "+15550001",
};

function setSub(over: Record<string, unknown>) {
  docs.set(`subAccounts/${SUB}`, {
    agencyId: "ag_1",
    whatsappEnabledByAgency: true,
    // The legacy field, left where it was — nothing updates it when the
    // default sender changes, which is precisely the trap.
    whatsappProvider: "twilio",
    twilioConfig: TWILIO_CONFIG,
    ...over,
  });
}

function submit() {
  return POST(
    new Request(
      `http://app.local/api/sub-accounts/${SUB}/whatsapp-templates/${TPL}/submit`,
      { method: "POST", headers: { "x-user-uid": "uid_admin" } },
    ),
    { params: Promise.resolve({ id: SUB, templateId: TPL }) },
  );
}

beforeEach(() => {
  createCloudTemplate.mockReset().mockResolvedValue({ id: "meta_1" });
  createContentTemplate.mockReset().mockResolvedValue({ contentSid: "HX1" });
  submitForWhatsappApproval.mockReset().mockResolvedValue(undefined);
  docs = new Map<string, Record<string, unknown>>([
    [
      `subAccounts/${SUB}/subAccountMembers/uid_admin`,
      { status: "active", subAccountRole: "admin", role: "admin" },
    ],
    [
      `subAccounts/${SUB}/whatsappTemplates/${TPL}`,
      {
        status: "draft",
        displayName: "Audit offer",
        name: "cresta_audit_offer",
        language: "en",
        category: "MARKETING",
        body: "Hi {{1}}",
        variables: [
          { position: 1, label: "Name", source: "manual", sampleValue: "Thabo" },
        ],
      },
    ],
  ]);
});

describe("submission targets the rail the sends will use", () => {
  it("submits on the default SENDER's rail, not on whatsappProvider", async () => {
    setSub({
      whatsappSenders: [
        {
          id: "s_cloud",
          label: "Support",
          provider: "cloud",
          phoneNumber: "+27784356159",
          isDefault: true,
        },
        {
          id: "s_twilio",
          label: "Sales",
          provider: "twilio",
          phoneNumber: "+15550001",
        },
      ],
    });
    const res = await submit();
    expect(res.status).toBe(200);
    expect(createCloudTemplate).toHaveBeenCalledTimes(1);
    expect(createContentTemplate).not.toHaveBeenCalled();
    // And the approval is recorded against that same rail.
    // `buildRegistrationUpdate` writes the dotted field path, which the fake
    // stores verbatim — the rail it names is the assertion.
    const tpl = docs.get(`subAccounts/${SUB}/whatsappTemplates/${TPL}`) as Record<
      string,
      { externalId?: string } | undefined
    >;
    expect(tpl["registrations.cloud"]?.externalId).toBe("meta_1");
    expect(tpl["registrations.twilio"]).toBeUndefined();
  });

  it("still submits over Twilio for a workspace with no sender registry", async () => {
    setSub({});
    const res = await submit();
    expect(res.status).toBe(200);
    expect(createContentTemplate).toHaveBeenCalledTimes(1);
    expect(submitForWhatsappApproval).toHaveBeenCalledTimes(1);
    expect(createCloudTemplate).not.toHaveBeenCalled();
  });

  it("refuses when the default sender is the bridge, which has no templates", async () => {
    setSub({
      whatsappSenders: [
        {
          id: "s_bridge",
          label: "Own number",
          provider: "bridge",
          phoneNumber: "+27784356159",
          isDefault: true,
        },
      ],
    });
    const res = await submit();
    expect(res.status).toBe(400);
    expect(createCloudTemplate).not.toHaveBeenCalled();
    expect(createContentTemplate).not.toHaveBeenCalled();
  });
});
