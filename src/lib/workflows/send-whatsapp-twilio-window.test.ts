import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";

import { createMemoryFirestore } from "@/test/memory-firestore";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types";
import type { WorkflowNode } from "@/types/workflows";

/**
 * A `send_whatsapp` step on the Twilio rail with the 24h window shut. Twilio
 * accepts a free-form create outside the window and rejects it later (63016),
 * so a step that sent its body there logged "ok" for a message that never
 * arrived. Real executor, real readiness, real dispatcher; the two Twilio
 * senders are spies.
 */

const mem = createMemoryFirestore();
const sendWhatsappForSubAccount = vi.fn(async () => ({ sid: "SMtext", from: "+27110000000" }));
const sendWhatsappTemplateForSubAccount = vi.fn(async () => ({ sid: "SMtpl", from: "+27110000000" }));

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/twilio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/twilio")>()),
  subAccountWhatsappIsConfigured: () => true,
  sendWhatsappForSubAccount: (...a: unknown[]) => sendWhatsappForSubAccount(...(a as [])),
  sendWhatsappTemplateForSubAccount: (...a: unknown[]) =>
    sendWhatsappTemplateForSubAccount(...(a as [])),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));

const { execSendWhatsapp } = await import("./engine");

const TWILIO = {
  name: "Velocity", agencyId: "ag1", whatsappEnabledByAgency: true, whatsappProvider: "twilio",
  twilioConfig: { enabled: true, accountSid: "AC1", authToken: "t", whatsappFromNumber: "+27110000000" },
} as unknown as SubAccountDoc;

function seedTemplate(over: Record<string, unknown>) {
  mem.seed("subAccounts/sa1/whatsappTemplates/follow_up", {
    name: "follow_up", displayName: "follow_up", language: "en",
    body: "Hi {{1}}, just checking in.",
    variables: [{ position: 1, label: "Name", sampleValue: "Sam", source: "merge_tag", mergeTag: "contact.firstName" }],
    ...over,
  });
}

const run = (templateId: string | null, contactName = "Thandi Mokoena") =>
  execSendWhatsapp({
    node: {
      id: "n1", type: "send_whatsapp",
      config: { body: "Free-form follow up", templateId },
    } as unknown as WorkflowNode,
    contact: {
      id: "c1", name: contactName, phone: "+27821234567", whatsappOptedOut: false,
    } as unknown as Contact,
    subAccount: TWILIO,
    owner: { displayName: "Hein", email: "h@example.com" },
    subAccountId: "sa1", agencyId: "ag1", createdByUid: "u1", workflowId: "wf1", runId: "run1", triggerContext: {},
  });

beforeEach(() => {
  mem.clear();
  sendWhatsappForSubAccount.mockClear();
  sendWhatsappTemplateForSubAccount.mockClear();
  mem.seed("subAccounts/sa1", TWILIO as unknown as Record<string, unknown>);
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Thandi Mokoena", phone: "+27821234567" });
  // Last inbound two days ago: the window is shut.
  mem.seed("contacts/c1/whatsappMessages/in1", {
    direction: "inbound", body: "hi",
    createdAt: Timestamp.fromMillis(Date.now() - 48 * 3_600_000),
  });
});

describe("send_whatsapp on Twilio, window shut", () => {
  it("sends the approved fallback template by its Content SID, not the body", async () => {
    seedTemplate({ status: "approved", contentSid: "HXapproved" });

    const out = await run("follow_up");

    expect(out.log).toBe("ok");
    expect(sendWhatsappForSubAccount).not.toHaveBeenCalled();
    expect(sendWhatsappTemplateForSubAccount).toHaveBeenCalledWith(
      expect.objectContaining({ contentSid: "HXapproved", contentVariables: ["Thandi"] }),
    );
    // The thread shows what the customer was actually sent.
    expect(mem.read("contacts/c1/whatsappMessages/SMtpl")?.body).toBe("Hi Thandi, just checking in.");
  });

  it("refuses unsent when a template variable is blank — Twilio may send the SAMPLE value", async () => {
    seedTemplate({ status: "approved", contentSid: "HXapproved" });

    const out = await run("follow_up", "");

    expect(out.log).toBe("error:WA_TEMPLATE_VARIABLE_EMPTY");
    expect(sendWhatsappTemplateForSubAccount).not.toHaveBeenCalled();
    expect(sendWhatsappForSubAccount).not.toHaveBeenCalled();
  });

  it("refuses visibly when the template is not approved on Twilio", async () => {
    seedTemplate({ status: "pending", contentSid: "HXpending" });

    const out = await run("follow_up");

    expect(out.log).toBe("error:WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE");
    expect(sendWhatsappForSubAccount).not.toHaveBeenCalled();
    expect(sendWhatsappTemplateForSubAccount).not.toHaveBeenCalled();
  });

  it("refuses visibly when the step has no template at all", async () => {
    const out = await run(null);

    expect(out.log).toBe("error:WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE");
    expect(sendWhatsappForSubAccount).not.toHaveBeenCalled();
  });
});
