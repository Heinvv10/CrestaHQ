import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MissedCallConfig, SubAccountDoc } from "@/types";

/**
 * SP2 row C5 — Missed Call Text Back had no unit test. Covers
 * `resolveVoiceRoute`'s three-condition gate (dedicated Twilio, agency gate,
 * MCTB config) and `handleMissedCall`'s core flow: dedup, reconcile, opt-out,
 * send, persist, log. The webhook routes decide WHEN to call handleMissedCall
 * (isMissedDialStatus) — covered separately since it's a pure filter.
 */

const m = vi.hoisted(() => ({
  claims: new Map<string, Record<string, unknown>>(),
  activities: [] as Record<string, unknown>[],
  messages: [] as Record<string, unknown>[],
  reconcileResult: { contactId: "contact_1", created: false } as
    | { contactId: string; created: boolean }
    | null,
  contactData: { name: "Jane Doe", phone: "+27821234567" } as
    | Record<string, unknown>
    | undefined,
  sendResult: { sid: "SM_sent_1", mode: "dedicated", from: "+15550001111" } as
    | { sid: string; mode: string; from: string }
    | null,
  sendError: null as Error | null,
  sendCalls: [] as { to: string; body: string }[],
  upsertCalls: [] as Record<string, unknown>[],
  /** Backs the `subAccounts` collection query resolveVoiceRoute() issues. */
  subAccountDoc: null as { id: string; data: Record<string, unknown> } | null,
}));

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    serverTimestamp: () => "SERVER_TS",
  },
}));

vi.mock("@/lib/api/webhooks/dispatch", () => ({
  emitWebhookEvent: vi.fn(async () => {}),
}));

vi.mock("@/lib/comms/ai/capture", () => ({
  reconcileContactFromCapture: vi.fn(async () => m.reconcileResult),
}));

vi.mock("@/lib/comms/twilio", () => ({
  sendSmsForSubAccount: vi.fn(async (args: { to: string; body: string }) => {
    m.sendCalls.push({ to: args.to, body: args.body });
    if (m.sendError) throw m.sendError;
    return m.sendResult;
  }),
}));

vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: vi.fn(async (args: Record<string, unknown>) => {
    m.upsertCalls.push(args);
  }),
}));

function claimRef(path: string) {
  return {
    get: async () => ({
      exists: m.claims.has(path),
      data: () => m.claims.get(path),
    }),
    set: (data: Record<string, unknown>) => {
      m.claims.set(path, data);
    },
  };
}

const subAccountsQuery = {
  where: () => subAccountsQuery,
  limit: () => subAccountsQuery,
  get: async () => {
    if (!m.subAccountDoc) return { empty: true, docs: [] };
    const { id, data } = m.subAccountDoc;
    return { empty: false, docs: [{ id, data: () => data }] };
  },
};

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => {
      if (path.includes("missedCallClaims")) return claimRef(path);
      if (path.startsWith("contacts/") && path.split("/").length === 2) {
        return { get: async () => ({ data: () => m.contactData }) };
      }
      if (path.includes("/messages/")) {
        return {
          set: async (data: Record<string, unknown>) => {
            m.messages.push(data);
          },
        };
      }
      return { get: async () => ({ data: () => undefined }) };
    },
    collection: (name: string) => {
      if (name === "subAccounts") return subAccountsQuery;
      return {
        doc: () => ({ id: "generated_msg_id" }),
        add: async (data: Record<string, unknown>) => {
          if (name.endsWith("/activities")) m.activities.push(data);
          return { id: "act_1" };
        },
      };
    },
    runTransaction: async (
      fn: (tx: {
        get: (ref: ReturnType<typeof claimRef>) => Promise<unknown>;
        set: (ref: ReturnType<typeof claimRef>, data: Record<string, unknown>) => void;
      }) => Promise<unknown>,
    ) =>
      fn({
        get: (ref) => ref.get(),
        set: (ref, data) => ref.set(data),
      }),
  }),
}));

import {
  handleMissedCall,
  isMissedDialStatus,
  renderMissedCallMessage,
  resolveVoiceRoute,
} from "./missed-call";

function baseTwilioConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    enabled: true,
    accountSid: "AC_fake",
    authToken: "tok_fake",
    fromNumber: "+15550001111",
    inboundWebhookConfigured: true,
    lastValidatedAt: null,
    inboundWebhookSecret: null,
    missedCall: {
      enabled: true,
      forwardTo: "+15559998888",
      ringTimeoutSec: 20,
      messageBody: "Sorry we missed your call {{firstName}} from {{businessName}}!",
      prevVoiceUrl: null,
      voiceWebhookConfigured: true,
    } satisfies MissedCallConfig,
    ...overrides,
  };
}

describe("isMissedDialStatus", () => {
  it("is true for no-answer/busy/failed/canceled and false for completed/in-progress", () => {
    expect(isMissedDialStatus("no-answer")).toBe(true);
    expect(isMissedDialStatus("busy")).toBe(true);
    expect(isMissedDialStatus("failed")).toBe(true);
    expect(isMissedDialStatus("canceled")).toBe(true);
    expect(isMissedDialStatus("completed")).toBe(false);
    expect(isMissedDialStatus("in-progress")).toBe(false);
    expect(isMissedDialStatus(undefined)).toBe(false);
    expect(isMissedDialStatus("")).toBe(false);
  });
});

describe("renderMissedCallMessage", () => {
  it("substitutes contact.firstName/firstName and workspace.name/businessName tags", () => {
    expect(
      renderMissedCallMessage("Hi {{firstName}}, call {{businessName}}!", {
        firstName: "Jane",
        businessName: "Acme",
      }),
    ).toBe("Hi Jane, call Acme!");
    expect(
      renderMissedCallMessage("Hi {{contact.firstName}} from {{workspace.name}}", {
        firstName: "Jane",
        businessName: "Acme",
      }),
    ).toBe("Hi Jane from Acme");
  });

  it("drops unknown tags rather than leaking a raw {{...}} to the customer", () => {
    expect(
      renderMissedCallMessage("Hi {{unknown.tag}} {{firstName}}", {
        firstName: "Jane",
        businessName: "Acme",
      }),
    ).toBe("Hi Jane");
  });
});

describe("resolveVoiceRoute", () => {
  beforeEach(() => {
    m.subAccountDoc = null;
  });

  it("returns null when no number matches (dedicated Twilio off / no such number)", async () => {
    expect(await resolveVoiceRoute("+15550001111")).toBeNull();
  });

  it("returns null when the agency gate is off", async () => {
    m.subAccountDoc = {
      id: "sa_1",
      data: {
        agencyId: "ag_1",
        missedCallTextBackEnabledByAgency: false,
        twilioConfig: baseTwilioConfig(),
      },
    };
    expect(await resolveVoiceRoute("+15550001111")).toBeNull();
  });

  it("returns null when missedCall.enabled is false", async () => {
    m.subAccountDoc = {
      id: "sa_1",
      data: {
        agencyId: "ag_1",
        missedCallTextBackEnabledByAgency: true,
        twilioConfig: baseTwilioConfig({
          missedCall: { ...baseTwilioConfig().missedCall, enabled: false },
        }),
      },
    };
    expect(await resolveVoiceRoute("+15550001111")).toBeNull();
  });

  it("returns null when forwardTo is missing", async () => {
    m.subAccountDoc = {
      id: "sa_1",
      data: {
        agencyId: "ag_1",
        missedCallTextBackEnabledByAgency: true,
        twilioConfig: baseTwilioConfig({
          missedCall: { ...baseTwilioConfig().missedCall, forwardTo: "" },
        }),
      },
    };
    expect(await resolveVoiceRoute("+15550001111")).toBeNull();
  });

  it("returns null when authToken is missing", async () => {
    m.subAccountDoc = {
      id: "sa_1",
      data: {
        agencyId: "ag_1",
        missedCallTextBackEnabledByAgency: true,
        twilioConfig: baseTwilioConfig({ authToken: "" }),
      },
    };
    expect(await resolveVoiceRoute("+15550001111")).toBeNull();
  });

  it("resolves a full route when all three conditions hold", async () => {
    m.subAccountDoc = {
      id: "sa_1",
      data: {
        agencyId: "ag_1",
        name: "E2E Fixture Primary",
        missedCallTextBackEnabledByAgency: true,
        twilioConfig: baseTwilioConfig(),
      },
    };
    const route = await resolveVoiceRoute("+15550001111");
    expect(route).toMatchObject({
      subAccountId: "sa_1",
      agencyId: "ag_1",
      authToken: "tok_fake",
    });
    expect(route?.missedCall.forwardTo).toBe("+15559998888");
  });
});

describe("handleMissedCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.claims.clear();
    m.activities.length = 0;
    m.messages.length = 0;
    m.upsertCalls.length = 0;
    m.sendCalls.length = 0;
    m.sendError = null;
    m.reconcileResult = { contactId: "contact_1", created: false };
    m.contactData = { name: "Jane Doe", phone: "+27821234567" };
    m.sendResult = { sid: "SM_sent_1", mode: "dedicated", from: "+15550001111" };
  });

  const route = {
    subAccountId: "sa_1",
    agencyId: "ag_1",
    authToken: "tok_fake",
    subAccount: {
      id: "sa_1",
      name: "E2E Fixture Primary",
      twilioConfig: baseTwilioConfig(),
    } as unknown as SubAccountDoc,
    missedCall: baseTwilioConfig().missedCall,
  };

  it("sends the rendered text-back once and persists message + conversation + activity", async () => {
    const result = await handleMissedCall({
      route,
      from: "+27821234567",
      callSid: "CA1",
    });
    expect(result).toMatchObject({ handled: true, contactId: "contact_1", smsSid: "SM_sent_1" });
    expect(m.sendCalls).toHaveLength(1);
    expect(m.sendCalls[0].body).toBe(
      "Sorry we missed your call Jane from E2E Fixture Primary!",
    );
    expect(m.messages).toHaveLength(1);
    expect(m.messages[0]).toMatchObject({ direction: "outbound", status: "sent", body: m.sendCalls[0].body });
    expect(m.upsertCalls).toHaveLength(1);
    expect(m.upsertCalls[0]).toMatchObject({ contactId: "contact_1", channel: "sms", direction: "outbound" });
    expect(m.activities).toHaveLength(1);
    expect(m.activities[0]).toMatchObject({ type: "missed_call" });
  });

  it("a duplicate callSid is claimed once and sends exactly once", async () => {
    const first = await handleMissedCall({ route, from: "+27821234567", callSid: "CA_dup" });
    const second = await handleMissedCall({ route, from: "+27821234567", callSid: "CA_dup" });
    expect(first.handled).toBe(true);
    expect(second).toEqual({ handled: false, reason: "already_handled" });
    expect(m.sendCalls).toHaveLength(1);
  });

  it("an opted-out caller is logged but never sent a text", async () => {
    m.contactData = { name: "Jane Doe", phone: "+27821234567", smsOptedOut: true };
    const result = await handleMissedCall({ route, from: "+27821234567", callSid: "CA2" });
    expect(result).toEqual({ handled: true, reason: "opted_out", contactId: "contact_1" });
    expect(m.sendCalls).toHaveLength(0);
    expect(m.activities).toHaveLength(1);
    expect(m.activities[0]).toMatchObject({ type: "missed_call" });
    expect((m.activities[0] as { content: string }).content).toContain("suppressed");
  });

  it("an unknown caller is reconciled to a newly-created contact", async () => {
    m.reconcileResult = { contactId: "contact_new", created: true };
    m.contactData = { name: "", phone: "+27821112222" };
    const result = await handleMissedCall({ route, from: "+27821112222", callSid: "CA3" });
    expect(result.contactId).toBe("contact_new");
    expect(m.sendCalls).toHaveLength(1);
  });

  it("a send failure is recorded (activity + result), not swallowed", async () => {
    m.sendError = new Error("Twilio 401: authenticate");
    const result = await handleMissedCall({ route, from: "+27821234567", callSid: "CA4" });
    expect(result).toMatchObject({ handled: false, reason: "send_failed", contactId: "contact_1" });
    expect(m.messages).toHaveLength(0); // no message row written on failure
    expect(m.activities).toHaveLength(1);
    expect((m.activities[0] as { content: string }).content).toContain("failed");
  });
});
