import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types";
import type { WorkflowNode } from "@/types/workflows";

/**
 * Executor-level tests for the `send_whatsapp` step.
 *
 * These exist because a unit test of `resolveWaSendMode` cannot catch the bug
 * that matters here. The send-mode rule is a pure function that was already
 * correct; what the executor adds is deciding WHAT to hand the dispatcher —
 * and a fallback template handed over with no parameters reaches Meta with
 * empty `{{1}}`, either rejected as a 400 or delivered to a customer with
 * visible placeholders. The assertion that matters is therefore what
 * `dispatchWhatsappSend` actually receives, which only a test that calls the
 * executor can make.
 */

const dispatchWhatsappSend = vi.fn();
const checkWhatsappReadiness = vi.fn();
let templateDoc: Record<string, unknown> | undefined;

vi.mock("@/lib/comms/whatsapp/send-dispatch", () => ({
  dispatchWhatsappSend: (...a: unknown[]) => dispatchWhatsappSend(...a),
}));
vi.mock("@/lib/comms/whatsapp/readiness", () => ({
  checkWhatsappReadiness: (...a: unknown[]) => checkWhatsappReadiness(...a),
}));
vi.mock("@/lib/comms/whatsapp/template-registrations", () => ({
  isTemplateApprovedFor: () => true,
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: () => ({
      get: async () => ({
        exists: templateDoc !== undefined,
        data: () => templateDoc,
      }),
    }),
    collection: () => ({ doc: () => ({ id: "x" }) }),
  }),
}));

import { execSendWhatsapp } from "./engine";

const contact = (over: Partial<Contact> = {}) =>
  ({
    id: "c1",
    name: "Thabo Mokoena",
    email: "t@example.com",
    phone: "+27821234567",
    whatsappOptedOut: false,
    ...over,
  }) as unknown as Contact;

const sub = () =>
  ({ whatsappEnabledByAgency: true }) as unknown as SubAccountDoc;

const ctx = (config: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({
    node: { id: "n1", type: "send_whatsapp", config } as unknown as WorkflowNode,
    contact: contact(),
    subAccount: sub(),
    owner: { displayName: "Hein", email: "h@example.com" },
    subAccountId: "sa_1",
    agencyId: "ag_1",
    createdByUid: "u_1",
    triggerContext: {},
    ...over,
  }) as Parameters<typeof execSendWhatsapp>[0];

describe("execSendWhatsapp", () => {
  beforeEach(() => {
    dispatchWhatsappSend.mockReset().mockResolvedValue({ ok: true });
    checkWhatsappReadiness
      .mockReset()
      .mockResolvedValue({ ready: true, provider: "cloud" });
    templateDoc = undefined;
  });

  it("sends the body with merge tags resolved, and no template when none is set", async () => {
    const r = await execSendWhatsapp(
      ctx({ body: "Hi {{contact.firstName}}, how did it go?" }),
    );
    expect(r.log).toBe("ok");
    const arg = dispatchWhatsappSend.mock.calls[0][0];
    expect(arg.body).toBe("Hi Thabo, how did it go?");
    expect(arg.template).toBeNull();
    expect(arg.to).toBe("+27821234567");
    expect(arg.subAccountId).toBe("sa_1");
  });

  it("fills the fallback template's variables instead of sending it empty", async () => {
    // THE BUG THIS GUARDS: components was hardcoded [], so a template
    // declaring {{1}}/{{2}} went to Meta with no parameters — a 400, or a
    // message showing raw placeholders to a customer.
    templateDoc = {
      name: "review_request_v2",
      language: "en",
      variables: [
        { position: 1, source: "merge_tag", mergeTag: "contact.firstName" },
        { position: 2, source: "manual" },
      ],
    };

    await execSendWhatsapp(
      ctx({
        body: "hello",
        templateId: "tpl_1",
        manualValues: { "2": "Blitz Fibre" },
      }),
    );

    const { template } = dispatchWhatsappSend.mock.calls[0][0];
    expect(template).not.toBeNull();
    expect(template.name).toBe("review_request_v2");
    expect(template.components).toHaveLength(1);
    expect(template.components[0]).toMatchObject({ type: "body" });
    const texts = template.components[0].parameters.map(
      (p: { text: string }) => p.text,
    );
    expect(texts).toContain("Thabo");
    expect(texts).toContain("Blitz Fibre");
  });

  it("resolves merge tags inside an operator-typed manual value", async () => {
    templateDoc = {
      name: "t",
      language: "en",
      variables: [{ position: 1, source: "manual" }],
    };
    await execSendWhatsapp(
      ctx({
        body: "hi",
        templateId: "tpl_1",
        manualValues: { "1": "Thanks {{contact.firstName}}" },
      }),
    );
    const { template } = dispatchWhatsappSend.mock.calls[0][0];
    expect(template.components[0].parameters[0].text).toBe("Thanks Thabo");
  });

  it("sends an empty components list for a template with no variables", async () => {
    templateDoc = { name: "t", language: "en", variables: [] };
    await execSendWhatsapp(ctx({ body: "hi", templateId: "tpl_1" }));
    const { template } = dispatchWhatsappSend.mock.calls[0][0];
    expect(template.components).toEqual([]);
  });

  it("refuses to send when the rail is not ready, whatever the rail is", async () => {
    checkWhatsappReadiness.mockResolvedValue({
      ready: false,
      provider: "bridge",
      error: "not available yet",
    });
    const r = await execSendWhatsapp(ctx({ body: "hi" }));
    expect(r.log).toBe("error:whatsapp_not_configured");
    expect(dispatchWhatsappSend).not.toHaveBeenCalled();
  });

  it("skips an opted-out contact before touching the rail", async () => {
    const r = await execSendWhatsapp(
      ctx({ body: "hi" }, { contact: contact({ whatsappOptedOut: true }) }),
    );
    expect(r.log).toBe("skipped:opt_out");
    expect(dispatchWhatsappSend).not.toHaveBeenCalled();
  });

  it("surfaces the dispatcher's refusal instead of reporting success", async () => {
    // Window shut with no template: the operator has to be able to see why.
    dispatchWhatsappSend.mockResolvedValue({
      ok: false,
      error: "WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE",
    });
    const r = await execSendWhatsapp(ctx({ body: "hi" }));
    expect(r.log).toBe("error:WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE");
  });

  it("skips an empty body rather than sending a blank message", async () => {
    const r = await execSendWhatsapp(ctx({ body: "   " }));
    expect(r.log).toBe("skipped:empty_body");
    expect(dispatchWhatsappSend).not.toHaveBeenCalled();
  });
});
