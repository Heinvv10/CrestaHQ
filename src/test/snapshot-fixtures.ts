import type { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Snapshot docs for the agency-key snapshot tools' tests (A4a-2): one
 * captured from sub-account `src`, one imported copy (`importedFrom`, no
 * source), both in agency ag1, and one in agency ag2. Every payload carries
 * one of each entity plus a persona, so a test can tell what was written.
 */

type Mem = ReturnType<typeof createMemoryFirestore>;

/** Text that only ever lives inside a payload: a listing must never show it. */
export const PAYLOAD_MARKER = "PAYLOAD-ONLY-7Q";

export const snapshotPayload = () => ({
  forms: [
    { sourceId: "f1", name: `Lead form ${PAYLOAD_MARKER}`, slug: "lead", fields: [], settings: { redirectUrl: "https://src.example" }, enabled: true },
  ],
  messageTemplates: [{ sourceId: "t1", type: "email", name: "Welcome", subject: "Hi", body: "Hello" }],
  products: [{ sourceId: "p1", name: "Install", unitPriceCents: 100, currency: "ZAR", active: true }],
  workflows: [
    {
      sourceId: "w1", name: "Follow up", status: "active", startNodeId: "n1", reentry: "every_time",
      trigger: { type: "form.submitted", formId: "f1", filters: { all: [], match: "all" } },
      nodes: { n1: { id: "n1", type: "add_tag", config: { tag: "lead" }, next: null } },
    },
  ],
  customFields: [{ sourceId: "cf1", entity: "contact", key: "install_date", label: "Install date", type: "text" }],
  aiProfile: { systemPrompt: `Persona ${PAYLOAD_MARKER}`, hoursStart: 8, hoursEnd: 17, timezone: "UTC", escalationKeywords: [] },
});

export const DAY = 24 * 60 * 60 * 1000;

export function seedSnapshots(mem: Mem) {
  const base = { version: 1, createdByUid: "owner1", payload: snapshotPayload() };
  mem.seed("agencies/ag1/snapshots/snap_own", {
    ...base, id: "snap_own", agencyId: "ag1", name: "Onboarding kit", description: "Our standard setup",
    sourceSubAccountId: "src", createdAt: new Date(Date.now() - DAY),
  });
  mem.seed("agencies/ag1/snapshots/snap_imp", {
    ...base, id: "snap_imp", agencyId: "ag1", name: "Bought kit", description: "",
    sourceSubAccountId: null, createdAt: new Date(), importedFrom: { importedAt: new Date(), via: "file" },
  });
  mem.seed("agencies/ag2/snapshots/snap_other", {
    ...base, id: "snap_other", agencyId: "ag2", name: "Other agency kit", description: "",
    sourceSubAccountId: "sb1", createdAt: new Date(),
  });
}

/** Every top-level doc an apply writes, for one target. */
export const appliedDocs = (mem: Mem, subAccountId: string) =>
  ["forms", "message_templates", "products", "workflows"].flatMap((c) =>
    mem.list(c).filter((d) => d.subAccountId === subAccountId).map((d): Record<string, unknown> => ({ ...d, collection: c }))
  );
