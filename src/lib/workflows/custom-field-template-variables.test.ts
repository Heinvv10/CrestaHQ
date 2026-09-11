import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types";
import type { WorkflowNode } from "@/types/workflows";

/**
 * Contact custom fields as WhatsApp template variables, save to send.
 *
 * The resolver has understood {{contact.customFields.<key>}} since 03f4d8f,
 * but a template variable could never MAP to one: the save routes checked
 * `mergeTag` against a fixed allow-list of seven contact scalars, so the
 * Velocity install template — first name, install address, install date, DR
 * reference — was refused before it could be submitted.
 *
 * So this saves that template through the real create route, then sends it
 * through the real `whatsapp_template` executor, and asserts the parameters
 * Meta would receive. Only the leaves are faked: tenancy auth, the WABA
 * credential read, and the Cloud client.
 */

const mem = createMemoryFirestore();
const sendWhatsappCloud = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "u_1" }),
}));
vi.mock("@/lib/comms/whatsapp/cloud-credentials", () => ({
  whatsappCloudIsConfigured: async () => true,
  getWabaCreds: async () => ({
    phoneNumberId: "pn_1",
    wabaId: "waba_1",
    accessToken: "tok",
  }),
}));
vi.mock("@/lib/comms/whatsapp/cloud-client", () => ({
  sendWhatsappCloud: (...a: unknown[]) => sendWhatsappCloud(...a),
}));

const { POST: createTemplate } = await import(
  "@/app/api/sub-accounts/[id]/whatsapp-templates/route"
);
const { PATCH: editTemplate } = await import(
  "@/app/api/sub-accounts/[id]/whatsapp-templates/[templateId]/route"
);
const { execWhatsappTemplate } = await import("./engine");

const SUB = {
  agencyId: "ag_1",
  whatsappEnabledByAgency: true,
  whatsappProvider: "cloud",
  whatsappCloudMeta: { phoneNumberId: "pn_1" },
} as unknown as SubAccountDoc;

/** docs/features/velocity-review-template-draft.md, template 1. */
const VELOCITY_BODY =
  "Hi {{1}}, your Velocity Fibre installation at {{2}} was completed on {{3}} (ref {{4}}). Was everything done to your satisfaction?";

const variable = (position: number, mergeTag: string) => ({
  position,
  label: mergeTag,
  sampleValue: `sample ${position}`,
  source: "merge_tag",
  mergeTag,
});

const VELOCITY_VARIABLES = [
  variable(1, "contact.firstName"),
  variable(2, "contact.customFields.install_address"),
  variable(3, "contact.customFields.install_date"),
  variable(4, "contact.customFields.dr_number"),
];

function defineContactField(key: string) {
  mem.seed(`subAccounts/sa_1/customFields/cf_${key}`, {
    entity: "contact",
    key,
    label: key,
    type: "text",
    options: [],
    required: false,
    order: 0,
    subAccountId: "sa_1",
    agencyId: "ag_1",
  });
}

async function save(variables: unknown[]): Promise<Response> {
  return createTemplate(
    new Request("https://app.test/api/sub-accounts/sa_1/whatsapp-templates", {
      method: "POST",
      body: JSON.stringify({
        displayName: "Velocity install experience",
        category: "UTILITY",
        body: VELOCITY_BODY,
        variables,
      }),
    }),
    { params: Promise.resolve({ id: "sa_1" }) },
  );
}

beforeEach(() => {
  mem.clear();
  sendWhatsappCloud.mockReset().mockResolvedValue({ ok: true, messageId: "wamid.1" });
  mem.seed("subAccounts/sa_1", SUB as unknown as Record<string, unknown>);
  for (const key of ["install_address", "install_date", "dr_number"]) {
    defineContactField(key);
  }
});

describe("a template variable mapped to a contact custom field", () => {
  it("saves, and sends the install details as the template's parameters", async () => {
    const res = await save(VELOCITY_VARIABLES);
    expect(res.status).toBeLessThan(300);
    const [stored] = mem.list("subAccounts/sa_1/whatsappTemplates");
    expect(stored.variables).toEqual(
      VELOCITY_VARIABLES.map((v) => expect.objectContaining({ mergeTag: v.mergeTag })),
    );

    // Meta approves it on the Cloud rail.
    mem.seed(`subAccounts/sa_1/whatsappTemplates/${stored.id}`, {
      ...stored,
      name: "velocity_install_experience_v1",
      registrations: {
        cloud: { externalId: "meta_1", status: "approved", rejectionReason: null },
      },
    });

    const out = await execWhatsappTemplate({
      node: {
        id: "n1",
        type: "whatsapp_template",
        config: { templateId: stored.id },
      } as unknown as WorkflowNode,
      contact: {
        id: "c1",
        name: "Thandi Mokoena",
        phone: "+27821234567",
        whatsappOptedOut: false,
        customFields: {
          install_address: "14 Acacia Street, Lawley",
          install_date: "9 September 2026",
          dr_number: "DR1734562",
        },
      } as unknown as Contact,
      subAccount: SUB,
      owner: { displayName: "Hein", email: "h@example.com" },
      subAccountId: "sa_1",
      agencyId: "ag_1",
      createdByUid: "u_1",
      workflowId: "wf1",
      runId: "run1",
      triggerContext: {},
    });

    expect(out.log).toBe("ok");
    expect(sendWhatsappCloud).toHaveBeenCalledTimes(1);
    const { template } = sendWhatsappCloud.mock.calls[0][0] as {
      template: { components: Array<{ parameters: Array<{ text: string }> }> };
    };
    expect(template.components[0].parameters.map((p) => p.text)).toEqual([
      "Thandi",
      "14 Acacia Street, Lawley",
      "9 September 2026",
      "DR1734562",
    ]);
  });

  it("refuses to save a variable mapped to a field this sub-account does not define", async () => {
    const res = await save([
      ...VELOCITY_VARIABLES.slice(0, 3),
      variable(4, "contact.customFields.dr_nuber"),
    ]);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/\{\{4\}\}/);
    expect(mem.list("subAccounts/sa_1/whatsappTemplates")).toHaveLength(0);
  });

  it("applies the same check when an existing template is edited", async () => {
    mem.seed("subAccounts/sa_1/whatsappTemplates/t1", {
      subAccountId: "sa_1",
      agencyId: "ag_1",
      status: "draft",
      body: VELOCITY_BODY,
      variables: VELOCITY_VARIABLES,
    });
    const patch = (variables: unknown[]) =>
      editTemplate(
        new Request("https://app.test/api/sub-accounts/sa_1/whatsapp-templates/t1", {
          method: "PATCH",
          body: JSON.stringify({ variables }),
        }),
        { params: Promise.resolve({ id: "sa_1", templateId: "t1" }) },
      );

    const good = await patch(VELOCITY_VARIABLES);
    expect(good.status).toBeLessThan(300);

    const bad = await patch([
      ...VELOCITY_VARIABLES.slice(0, 3),
      variable(4, "contact.customFields.not_a_field"),
    ]);
    expect(bad.status).toBe(400);
  });

  it("still refuses a tag outside both the allow-list and the custom fields", async () => {
    const res = await save([
      ...VELOCITY_VARIABLES.slice(0, 3),
      variable(4, "contact.company"),
    ]);
    expect(res.status).toBe(400);
  });
});

