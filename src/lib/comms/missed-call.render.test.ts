import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: vi.fn() }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn() }));
vi.mock("@/lib/comms/ai/capture", () => ({
  reconcileContactFromCapture: vi.fn(),
}));
vi.mock("@/lib/comms/twilio", () => ({ sendSmsForSubAccount: vi.fn() }));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: vi.fn(),
}));
import { DEFAULT_MCTB_MESSAGE, renderMissedCallMessage } from "./missed-call";

const ctx = {
  contact: { name: "  Thabo  Mokoena " },
  businessName: "Velo Desk",
};

describe("renderMissedCallMessage (legacy text-back tags through the shared renderer)", () => {
  it("renders the legacy aliases, case-insensitively", () => {
    expect(
      renderMissedCallMessage(
        "Hi {{firstName}} / {{ contact.firstName }} / {{FIRSTNAME}} — {{businessName}} ({{workspace.name}})",
        ctx
      )
    ).toBe("Hi Thabo / Thabo / Thabo — Velo Desk (Velo Desk)");
  });

  it("a nameless caller gets no broken template: tags collapse, spaces tidy", () => {
    expect(
      renderMissedCallMessage(
        "Hi {{firstName}}, {{businessName}} here.  {{foo}} {{}}",
        {
          contact: { name: "" },
          businessName: "Velo Desk",
        }
      )
    ).toBe("Hi , Velo Desk here.");
  });

  it("canonical tags work, and a missing canonical value is dropped", () => {
    expect(
      renderMissedCallMessage(
        "{{contact.first_name}} {{contact.email}} at {{business.name}}",
        ctx
      )
    ).toBe("Thabo at Velo Desk");
  });

  it("the default message passes through unchanged", () => {
    expect(renderMissedCallMessage(DEFAULT_MCTB_MESSAGE, ctx)).toBe(
      DEFAULT_MCTB_MESSAGE
    );
  });
});
