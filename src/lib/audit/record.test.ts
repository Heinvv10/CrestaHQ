import { beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED, auditValue, recordAuditEvent, storedValue } from "./record";
import type { AuditEventInput } from "./types";

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));

const written: { collection: string; data: Record<string, unknown> }[] = [];
let failWrites = false;

const db = {
  collection: (name: string) => ({
    add: async (data: Record<string, unknown>) => {
      if (failWrites) throw new Error("firestore down");
      written.push({ collection: name, data });
      return { id: `auto_${written.length}` };
    },
  }),
} as unknown as FirebaseFirestore.Firestore;

function event(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    action: "member.role_changed",
    actor: { type: "user", id: "uid_owner" },
    target: { type: "member", id: "uid_member" },
    agencyId: "agency_1",
    subAccountId: "sa_1",
    changes: [{ field: "role", before: "collaborator", after: "admin" }],
    ...overrides,
  };
}

beforeEach(() => {
  written.length = 0;
  failWrites = false;
  vi.restoreAllMocks();
});

describe("recordAuditEvent", () => {
  it("writes one tenant-stamped row to auditEvents", async () => {
    await recordAuditEvent(db, event());
    expect(written).toEqual([
      {
        collection: "auditEvents",
        data: {
          action: "member.role_changed",
          actor: { type: "user", id: "uid_owner" },
          target: { type: "member", id: "uid_member" },
          agencyId: "agency_1",
          subAccountId: "sa_1",
          createdByUid: "uid_owner",
          changes: [{ field: "role", before: "collaborator", after: "admin" }],
          createdAt: "SERVER_TS",
        },
      },
    ]);
  });

  it("stamps createdByUid null when the actor is not a user", async () => {
    await recordAuditEvent(db, event({ actor: { type: "api_key", id: "key_1" } }));
    expect(written[0].data.createdByUid).toBeNull();
    expect(written[0].data.actor).toEqual({ type: "api_key", id: "key_1" });
  });

  it("stamps createdByUid with the user a non-user actor acted for", async () => {
    await recordAuditEvent(
      db,
      event({ actor: { type: "ai_agent", id: "workspace-assistant" }, onBehalfOfUid: "uid_asker" })
    );
    expect(written[0].data.createdByUid).toBe("uid_asker");
    expect(written[0].data).not.toHaveProperty("onBehalfOfUid");
  });

  it("a user actor's own uid wins over onBehalfOfUid", async () => {
    await recordAuditEvent(db, event({ onBehalfOfUid: "uid_other" }));
    expect(written[0].data.createdByUid).toBe("uid_owner");
  });

  it("refuses an empty onBehalfOfUid", async () => {
    await expect(
      recordAuditEvent(db, event({ actor: { type: "ai_agent", id: "a" }, onBehalfOfUid: "" }))
    ).rejects.toThrow(/onBehalfOfUid/);
    expect(written).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    ["unknown type", { type: "someone", id: "x" }],
    ["empty id", { type: "user", id: "" }],
  ])("refuses an event whose actor is %s, and writes nothing", async (_label, actor) => {
    await expect(
      recordAuditEvent(db, event({ actor: actor as AuditEventInput["actor"] }))
    ).rejects.toThrow(/actor/);
    expect(written).toHaveLength(0);
  });

  it("refuses an event with no agencyId", async () => {
    await expect(recordAuditEvent(db, event({ agencyId: "" }))).rejects.toThrow(/agencyId/);
    expect(written).toHaveLength(0);
  });

  it("refuses an unknown action", async () => {
    await expect(
      recordAuditEvent(db, event({ action: "contact.deleted" as AuditEventInput["action"] }))
    ).rejects.toThrow(/unknown action/);
    expect(written).toHaveLength(0);
  });

  it("refuses a target with no id", async () => {
    await expect(
      recordAuditEvent(db, event({ target: { type: "member", id: "" } }))
    ).rejects.toThrow(/target/);
    expect(written).toHaveLength(0);
  });

  it("accepts an agency-level event with subAccountId null", async () => {
    await recordAuditEvent(db, event({ subAccountId: null }));
    expect(written[0].data.subAccountId).toBeNull();
  });

  it("logs, and does not throw, when the write itself fails", async () => {
    failWrites = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordAuditEvent(db, event())).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(
      "[audit] failed to record member.role_changed on member/uid_member",
      expect.any(Error)
    );
  });

  it("stores a value only when its action + field allow-list names it", async () => {
    await recordAuditEvent(
      db,
      event({
        changes: [
          { field: "role", before: "collaborator", after: "admin" },
          { field: "email", before: "jane@example.com", after: "john@example.com" },
          { field: "body", before: null, after: "hi there, your install is booked" },
        ],
      })
    );
    expect(written[0].data.changes).toEqual([
      { field: "role", before: "collaborator", after: "admin" },
      { field: "email", before: REDACTED, after: REDACTED },
      { field: "body", before: null, after: REDACTED },
    ]);
  });
});

describe("auditValue", () => {
  it.each([
    // allowed: listed values for a listed field
    ["member.role_changed", "role", "admin", "admin"],
    ["member.role_changed", "role", "collaborator", "collaborator"],
    ["workflow.status_changed", "status", "paused", "paused"],
    ["feature_gates.updated", "googleEnabledByAgency", false, false],
    ["feature_gates.updated", "whatsappEnabledByAgency", true, true],
    // absence is not PII
    ["member.role_changed", "role", null, null],
    ["member.role_changed", "role", undefined, null],
    // a listed field, an unlisted value
    ["member.role_changed", "role", "owner", REDACTED],
    ["workflow.status_changed", "status", "archived", REDACTED],
    ["feature_gates.updated", "googleEnabledByAgency", "true", REDACTED],
    ["feature_gates.updated", "googleEnabledByAgency", 1, REDACTED],
    // names, domains, emails, phones and numbers — even enum-shaped ones
    ["member.role_changed", "role", "jane", REDACTED],
    ["member.role_changed", "name", "jane", REDACTED],
    ["member.role_changed", "name", "Jane Smith", REDACTED],
    ["feature_gates.updated", "domain", "velocityfibre.co.za", REDACTED],
    ["feature_gates.updated", "domain", "mail.example.com", REDACTED],
    ["member.role_changed", "email", "jane@example.com", REDACTED],
    ["member.role_changed", "phone", "+27821234567", REDACTED],
    ["member.role_changed", "count", 3, REDACTED],
    ["workflow.status_changed", "amount", 0, REDACTED],
    ["feature_gates.updated", "usageQuotas", 500, REDACTED],
    // a field allowed for one action is not allowed for another
    ["workflow.status_changed", "role", "admin", REDACTED],
    ["member.role_changed", "status", "active", REDACTED],
    // prototype keys are not fields
    ["member.role_changed", "constructor", "admin", REDACTED],
  ] as const)("%s %s %j -> %j", (action, field, input, expected) => {
    expect(auditValue(action, field, input)).toBe(expected);
  });
});

describe("storedValue: a staffUid field", () => {
  it.each([
    ["uid_owner", "uid_owner"],
    ["Xk3fP9qLm2RtYv7WbN4cD8eHj1A2", "Xk3fP9qLm2RtYv7WbN4cD8eHj1A2"],
    [null, null],
    [undefined, null],
    ["jane@example.com", REDACTED],
    ["Jane Smith", REDACTED],
    ["velocityfibre.co.za", REDACTED],
    ["+27821234567", REDACTED],
    ["", REDACTED],
    ["a".repeat(129), REDACTED],
    [42, REDACTED],
    [true, REDACTED],
  ] as const)("%j -> %j", (input, expected) => {
    expect(storedValue("staffUid", input)).toBe(expected);
  });

  it("a value list stays a value list: a uid in a listed field is redacted", () => {
    expect(storedValue(["admin"], "uid_owner")).toBe(REDACTED);
    expect(storedValue(undefined, "uid_owner")).toBe(REDACTED);
  });
});

describe("the system actor", () => {
  it("is accepted, with createdByUid null", async () => {
    await recordAuditEvent(db, event({ actor: { type: "system", id: "inbound-whatsapp" } }));
    expect(written[0].data.actor).toEqual({ type: "system", id: "inbound-whatsapp" });
    expect(written[0].data.createdByUid).toBeNull();
  });
});
