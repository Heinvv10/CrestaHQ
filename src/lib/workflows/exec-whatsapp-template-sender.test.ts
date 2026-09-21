import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types";
import type { WorkflowNode } from "@/types/workflows";

/**
 * The `whatsapp_template` step against the sender registry.
 *
 * Deliberately NOT a test of `resolveWhatsappSender` — that resolver is
 * covered on its own. What can only be proven here is that the three gates the
 * step runs through (readiness, per-rail template approval, dispatch) resolve
 * the SAME sender. They used to resolve it twice, from two different
 * functions, which is how a step gets admitted on one rail and refused on the
 * next.
 *
 * So everything below the executor is real: the readiness check, the resolver,
 * the approval check and the template dispatcher all run. Only the leaves —
 * the credential reads and the two provider clients — are faked.
 */

const sendWhatsappCloud = vi.fn();
const sendWhatsappTemplateForSubAccount = vi.fn();
let templateDoc: Record<string, unknown> | undefined;

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
vi.mock("@/lib/comms/twilio", () => ({
  subAccountWhatsappIsConfigured: () => true,
  sendWhatsappTemplateForSubAccount: (...a: unknown[]) =>
    sendWhatsappTemplateForSubAccount(...a),
  sendWhatsappForSubAccount: async () => ({ sid: "SM1", from: "+15550001" }),
  sendSmsForSubAccount: async () => ({ sid: "SM2" }),
  smsIsConfigured: () => true,
  subAccountTwilioIsConfigured: () => true,
  SmsRecipientUnsubscribedError: class extends Error {},
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: () => ({
      get: async () => ({
        exists: templateDoc !== undefined,
        data: () => templateDoc,
      }),
    }),
    collection: () => ({ doc: () => ({ id: "x", set: async () => {} }) }),
    runTransaction: async () => undefined,
  }),
}));

import { execWhatsappTemplate } from "./engine";

const TWILIO_SENDER = {
  id: "s_twilio",
  label: "Sales",
  provider: "twilio" as const,
  phoneNumber: "+15550001",
  isDefault: true,
};
const CLOUD_SENDER = {
  id: "s_cloud",
  label: "Support",
  provider: "cloud" as const,
  phoneNumber: "+27784356159",
};

/**
 * Approved on the CLOUD rail only. That asymmetry is the probe: a step whose
 * three gates disagree about the rail either refuses a template that is
 * approved, or sends one that is not.
 */
const CLOUD_ONLY_TEMPLATE = {
  name: "cresta_audit_offer",
  displayName: "Audit offer",
  language: "en",
  variables: [],
  registrations: {
    cloud: { externalId: "meta_1", status: "approved", rejectionReason: null },
  },
};

const sub = (over: Partial<SubAccountDoc> = {}) =>
  ({
    whatsappEnabledByAgency: true,
    whatsappProvider: "twilio",
    twilioConfig: { whatsappFromNumber: "+15550001" },
    whatsappSenders: [TWILIO_SENDER, CLOUD_SENDER],
    ...over,
  }) as unknown as SubAccountDoc;

const ctx = (
  config: Record<string, unknown>,
  subAccount: SubAccountDoc = sub(),
) =>
  ({
    node: {
      id: "n1",
      type: "whatsapp_template",
      config,
    } as unknown as WorkflowNode,
    contact: {
      id: "c1",
      name: "Thabo Mokoena",
      phone: "+27821234567",
      whatsappOptedOut: false,
    } as unknown as Contact,
    subAccount,
    owner: { displayName: "Hein", email: "h@example.com" },
    subAccountId: "sa_1",
    agencyId: "ag_1",
    createdByUid: "u_1",
    workflowId: "wf1",
    runId: "run1",
    triggerContext: {},
  }) as Parameters<typeof execWhatsappTemplate>[0];

beforeEach(() => {
  sendWhatsappCloud.mockReset().mockResolvedValue({ ok: true, messageId: "wamid.1" });
  sendWhatsappTemplateForSubAccount.mockReset().mockResolvedValue({ sid: "SM1" });
  templateDoc = { ...CLOUD_ONLY_TEMPLATE };
});

describe("the step's chosen sender reaches every gate", () => {
  it("sends on the sender the step named, not the workspace default", async () => {
    const out = await execWhatsappTemplate(
      ctx({ templateId: "t1", senderId: "s_cloud" }),
    );
    expect(out.log).toBe("ok");
    // Approval was checked on cloud (it passed) AND the dispatch went out on
    // the cloud client — the two gates saw the same sender.
    expect(sendWhatsappCloud).toHaveBeenCalledTimes(1);
    expect(sendWhatsappTemplateForSubAccount).not.toHaveBeenCalled();
  });

  it("falls back to the default sender when the step names none", async () => {
    // The default is Twilio, where this template has no registration — so the
    // approval gate refuses it. An unset senderId must NOT drift to the cloud
    // sender just because the template happens to be approved there.
    const out = await execWhatsappTemplate(ctx({ templateId: "t1" }));
    expect(out.log).toBe("error:template_not_approved");
    expect(sendWhatsappCloud).not.toHaveBeenCalled();
  });

  it("refuses a sender id that is not this workspace's", async () => {
    const out = await execWhatsappTemplate(
      ctx({ templateId: "t1", senderId: "s_from_another_workspace" }),
    );
    // Refused at readiness — before any send, and without falling back to the
    // default number.
    expect(out.log).toBe("error:whatsapp_not_configured");
    expect(sendWhatsappCloud).not.toHaveBeenCalled();
    expect(sendWhatsappTemplateForSubAccount).not.toHaveBeenCalled();
  });
});

describe("a workspace with no sender registry is unchanged", () => {
  it("sends on the rail its whatsappProvider names, as it did before", async () => {
    templateDoc = {
      ...CLOUD_ONLY_TEMPLATE,
      registrations: {
        twilio: {
          externalId: "HX1",
          status: "approved",
          rejectionReason: null,
        },
      },
    };
    const out = await execWhatsappTemplate(
      ctx({ templateId: "t1" }, sub({ whatsappSenders: undefined })),
    );
    expect(out.log).toBe("ok");
    expect(sendWhatsappTemplateForSubAccount).toHaveBeenCalledTimes(1);
    expect(sendWhatsappCloud).not.toHaveBeenCalled();
  });

  it("sends on cloud when that is the workspace's rail", async () => {
    const out = await execWhatsappTemplate(
      ctx(
        { templateId: "t1" },
        sub({
          whatsappSenders: undefined,
          whatsappProvider: "cloud",
          whatsappCloudMeta: { phoneNumberId: "pn_1" },
        } as Partial<SubAccountDoc>),
      ),
    );
    expect(out.log).toBe("ok");
    expect(sendWhatsappCloud).toHaveBeenCalledTimes(1);
  });
});
