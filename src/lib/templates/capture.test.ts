import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { captureEntity, TemplateCaptureError } from "./capture";

const mem = createMemoryFirestore();
const db = mem.db as unknown as Firestore;
const scope = { agencyId: "ag1", subAccountId: "sa1" };

const tenancy = (subAccountId: string, agencyId = "ag1") => ({
  agencyId,
  subAccountId,
  createdByUid: "u1",
  createdAt: new Date(),
  updatedAt: new Date(),
});

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "One" });
  mem.seed("subAccounts/sa2", { agencyId: "ag1", name: "Two" });
  mem.seed("subAccounts/other", { agencyId: "ag2", name: "Foreign" });
  mem.seed("forms/f1", {
    id: "f1",
    name: "Quote form",
    slug: "quote",
    fields: [],
    settings: {},
    enabled: true,
    submissionCount: 12,
    ...tenancy("sa1"),
  });
  mem.seed("workflows/w1", {
    id: "w1",
    name: "Follow up",
    status: "active",
    trigger: { type: "form.submitted", formId: "f1", filters: { all: [], match: "all" } },
    startNodeId: "n1",
    nodes: { n1: { id: "n1", type: "add_tag", config: { tag: "x" }, next: null } },
    stats: { enrolled: 4, completed: 2 },
    ...tenancy("sa1"),
  });
  mem.seed("workflows/w2", {
    id: "w2",
    name: "On create",
    status: "active",
    trigger: { type: "contact.created", filters: { all: [], match: "all" } },
    startNodeId: null,
    nodes: {},
    stats: { enrolled: 0, completed: 0 },
    ...tenancy("sa1"),
  });
  mem.seed("message_templates/t1", {
    id: "t1",
    type: "email",
    name: "Welcome",
    subject: "Hi",
    body: "Hello",
    ...tenancy("sa1"),
  });
  mem.seed("message_templates/t2", {
    id: "t2",
    type: "sms",
    name: "Ping",
    subject: null,
    body: "Hi",
    ...tenancy("sa1"),
  });
  mem.seed("workflows/w_sa2", {
    id: "w_sa2",
    name: "Elsewhere",
    status: "draft",
    trigger: { type: "contact.created" },
    startNodeId: null,
    nodes: {},
    stats: { enrolled: 0, completed: 0 },
    ...tenancy("sa2"),
  });
  mem.seed("workflows/w_other", {
    id: "w_other",
    name: "Foreign",
    status: "draft",
    trigger: { type: "contact.created" },
    startNodeId: null,
    nodes: {},
    stats: { enrolled: 0, completed: 0 },
    ...tenancy("other", "ag2"),
  });
});

describe("captureEntity", () => {
  it("captures a form with tenancy and the submission counter stripped", async () => {
    const r = await captureEntity(db, scope, "form", "f1");
    expect(r.entityName).toBe("Quote form");
    expect(r.includesTriggerForm).toBe(false);
    expect(r.payload.forms).toHaveLength(1);
    expect(r.payload.workflows).toEqual([]);
    expect(r.payload.messageTemplates).toEqual([]);
    const form = r.payload.forms[0] as unknown as Record<string, unknown>;
    expect(form.sourceId).toBe("f1");
    expect(form.name).toBe("Quote form");
    for (const k of ["id", "agencyId", "subAccountId", "createdByUid", "createdAt", "updatedAt", "submissionCount"]) {
      expect(form, k).not.toHaveProperty(k);
    }
  });

  it("captures an email template stripped of tenancy", async () => {
    const r = await captureEntity(db, scope, "email", "t1");
    expect(r.entityName).toBe("Welcome");
    expect(r.payload.messageTemplates).toHaveLength(1);
    const t = r.payload.messageTemplates[0] as unknown as Record<string, unknown>;
    expect(t.sourceId).toBe("t1");
    expect(t.subject).toBe("Hi");
    expect(t).not.toHaveProperty("subAccountId");
    expect(t).not.toHaveProperty("agencyId");
  });

  it("refuses an SMS template under the email kind", async () => {
    await expect(captureEntity(db, scope, "email", "t2")).rejects.toBeInstanceOf(
      TemplateCaptureError,
    );
  });

  it("captures a form-triggered workflow together with its trigger form, stats stripped", async () => {
    const r = await captureEntity(db, scope, "workflow", "w1");
    expect(r.entityName).toBe("Follow up");
    expect(r.includesTriggerForm).toBe(true);
    expect(r.payload.workflows).toHaveLength(1);
    expect(r.payload.forms).toHaveLength(1);
    const w = r.payload.workflows[0] as unknown as Record<string, unknown>;
    expect(w.sourceId).toBe("w1");
    expect(w).not.toHaveProperty("stats");
    expect(w).not.toHaveProperty("subAccountId");
    // Source id kept so apply can remap it to the pushed form.
    expect((w.trigger as { formId: string }).formId).toBe("f1");
    expect(r.payload.forms[0].sourceId).toBe("f1");
  });

  it("captures a workflow without a form trigger alone", async () => {
    const r = await captureEntity(db, scope, "workflow", "w2");
    expect(r.includesTriggerForm).toBe(false);
    expect(r.payload.forms).toEqual([]);
    expect(r.payload.workflows).toHaveLength(1);
  });

  it("does not carry a trigger form that lives in another sub-account", async () => {
    mem.seed("workflows/w3", {
      id: "w3",
      name: "Cross",
      status: "draft",
      trigger: { type: "form.submitted", formId: "f_sa2" },
      startNodeId: null,
      nodes: {},
      stats: { enrolled: 0, completed: 0 },
      ...tenancy("sa1"),
    });
    mem.seed("forms/f_sa2", { id: "f_sa2", name: "Not mine", fields: [], ...tenancy("sa2") });
    const r = await captureEntity(db, scope, "workflow", "w3");
    expect(r.includesTriggerForm).toBe(false);
    expect(r.payload.forms).toEqual([]);
  });

  it("refuses an entity that belongs to a different sub-account of the same agency", async () => {
    await expect(
      captureEntity(db, scope, "workflow", "w_sa2"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses when the named sub-account is in another agency, even if the entity matches it", async () => {
    await expect(
      captureEntity(db, { agencyId: "ag1", subAccountId: "other" }, "workflow", "w_other"),
    ).rejects.toMatchObject({ status: 404, message: "Sub-account not found in this agency." });
  });

  it("refuses an unknown id and an unknown sub-account", async () => {
    await expect(captureEntity(db, scope, "form", "nope")).rejects.toMatchObject({ status: 404 });
    await expect(
      captureEntity(db, { agencyId: "ag1", subAccountId: "ghost" }, "form", "f1"),
    ).rejects.toMatchObject({ status: 404 });
  });
});
