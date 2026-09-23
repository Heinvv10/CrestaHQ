import { describe, it, expect } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { captureSnapshot } from "./capture";
import { applySnapshot } from "./apply";
import type { SnapshotPayload } from "@/types/snapshots";

/**
 * Minimal Firestore fake. Collections and docs are addressed by path string;
 * `.doc()` with no id mints a fresh one, mirroring the real auto-id behaviour
 * the apply path relies on. Writes are recorded per path so a test can assert
 * both WHAT was written and WHETHER an existing doc was touched.
 */
function fakeDb(seed: {
  collections?: Record<string, { id: string; data: Record<string, unknown> }[]>;
  docs?: Record<string, Record<string, unknown> | undefined>;
}) {
  const written: { path: string; data: Record<string, unknown> }[] = [];
  let auto = 0;

  const docsAt = (path: string) => seed.collections?.[path] ?? [];

  const collection = (path: string) => ({
    where: () => collection(path),
    get: async () => ({
      docs: docsAt(path).map((d) => ({ id: d.id, data: () => d.data })),
    }),
    doc: () => {
      const id = `new_${++auto}`;
      return { id, path: `${path}/${id}` };
    },
  });

  const db = {
    collection,
    doc: (path: string) => ({
      id: path.split("/").pop()!,
      path,
      get: async () => {
        const data = seed.docs?.[path];
        return { exists: data !== undefined, data: () => data };
      },
      // Only `applySnapshot`'s own status doc (snapshotApplies/*) writes via
      // this path outside a transaction; record it like the batch does.
      set: async (data: Record<string, unknown>) => {
        written.push({ path, data });
      },
    }),
    // The create-if-absent existence check — nothing in `seed.docs` is a
    // form/template/product/workflow in these tests, so every ref reads back
    // as absent (created), matching the old create-only behaviour.
    getAll: async (...refs: { path: string }[]) =>
      refs.map((ref) => {
        const data = seed.docs?.[ref.path];
        return { ref, exists: data !== undefined, data: () => data };
      }),
    batch: () => ({
      set: (ref: { path: string }, data: Record<string, unknown>) => {
        written.push({ path: ref.path, data });
      },
      commit: async () => {},
    }),
    // The persona write runs in a transaction that RE-READS the profile, so the
    // fake must serve the read from `seed.docs` the same way `db.doc().get()`
    // does — otherwise the test would prove nothing about the re-read.
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        get: async (ref: { path: string }) => {
          const data = seed.docs?.[ref.path];
          return { exists: data !== undefined, data: () => data };
        },
        set: (ref: { path: string }, data: Record<string, unknown>) => {
          written.push({ path: ref.path, data });
        },
      }),
  } as unknown as Firestore;

  return { db, written };
}

const emptyPayload = (): SnapshotPayload => ({
  forms: [],
  messageTemplates: [],
  products: [],
  workflows: [],
});

describe("captureSnapshot — AI persona", () => {
  const base = {
    collections: {
      forms: [],
      message_templates: [],
      products: [],
      workflows: [],
      "subAccounts/sa_src/customFields": [],
    },
  };

  it("drops the source client's business identity and scraped KB", async () => {
    // The bug this guards: carrying websiteKb into another client's workspace
    // makes the agent state facts about the WRONG business, confidently. The
    // escalation inbox is worse — it routes one client's leads to another's team.
    const { db } = fakeDb({
      ...base,
      docs: {
        "subAccounts/sa_src/aiAgent/profile": {
          systemPrompt: "You are Velo from Velocity Fibre.",
          businessName: "Velocity Fibre",
          hoursStart: 8,
          hoursEnd: 17,
          timezone: "Africa/Johannesburg",
          escalationKeywords: ["manager", "complaint"],
          escalationNotifyEmail: "ops@velocityfibre.co.za",
          websiteUrl: "https://velocityfibre.co.za",
          websiteKb: "# Velocity Fibre\nFTTH build and transfer...",
          websiteKbFetchedAt: "2026-08-01",
        },
      },
    });

    const payload = await captureSnapshot(db, "sa_src");

    expect(payload.aiProfile).toEqual({
      systemPrompt: "You are Velo from Velocity Fibre.",
      hoursStart: 8,
      hoursEnd: 17,
      timezone: "Africa/Johannesburg",
      escalationKeywords: ["manager", "complaint"],
    });
    const carried = JSON.stringify(payload.aiProfile);
    expect(carried).not.toContain("ops@velocityfibre.co.za");
    expect(carried).not.toContain("FTTH build and transfer");
  });

  it("carries no persona when the source never set a prompt", async () => {
    const { db } = fakeDb({
      ...base,
      docs: {
        "subAccounts/sa_src/aiAgent/profile": {
          systemPrompt: "   ",
          businessName: "Unset",
        },
      },
    });
    expect((await captureSnapshot(db, "sa_src")).aiProfile).toBeNull();
  });

  it("strips tenancy from custom-field definitions but keeps the key", async () => {
    const { db } = fakeDb({
      ...base,
      collections: {
        ...base.collections,
        "subAccounts/sa_src/customFields": [
          {
            id: "cf1",
            data: {
              entity: "contact",
              key: "install_date",
              label: "Install date",
              type: "date",
              folderId: "folder_src",
              subAccountId: "sa_src",
              agencyId: "ag_1",
              createdByUid: "u_1",
            },
          },
        ],
      },
      docs: {},
    });

    const [field] = (await captureSnapshot(db, "sa_src")).customFields!;
    expect(field.key).toBe("install_date");
    expect(field.sourceId).toBe("cf1");
    expect(field).not.toHaveProperty("subAccountId");
    expect(field).not.toHaveProperty("agencyId");
    // Folders do not travel; a copied folderId would dangle on the target.
    expect(field).not.toHaveProperty("folderId");
  });
});

describe("applySnapshot — create-only guarantees", () => {
  const scope = { agencyId: "ag_1", createdByUid: "u_1", snapshotId: "snap_1" };

  it("never overwrites a persona the target already tuned", async () => {
    // The bug this guards: aiAgent/profile is a FIXED path, so a plain write
    // would silently replace a live agent's prompt mid-conversation.
    const { db, written } = fakeDb({
      collections: { "subAccounts/sa_dst/customFields": [] },
      docs: {
        "subAccounts/sa_dst/aiAgent/profile": {
          systemPrompt: "Tuned by the operator over six weeks.",
        },
      },
    });

    const result = await applySnapshot(
      db,
      { ...emptyPayload(), aiProfile: { systemPrompt: "Generic", hoursStart: 0, hoursEnd: 0, timezone: "UTC", escalationKeywords: [] } },
      "sa_dst",
      scope,
    );

    expect(result.aiProfileApplied).toBe(false);
    expect(written.some((w) => w.path.endsWith("aiAgent/profile"))).toBe(false);
  });

  it("writes the persona when the target has none, re-blanked for the new client", async () => {
    const { db, written } = fakeDb({
      collections: { "subAccounts/sa_dst/customFields": [] },
      docs: {},
    });

    const result = await applySnapshot(
      db,
      {
        ...emptyPayload(),
        aiProfile: {
          systemPrompt: "You are Velo from Velocity Fibre.",
          hoursStart: 8,
          hoursEnd: 17,
          timezone: "Africa/Johannesburg",
          escalationKeywords: ["manager"],
        },
      },
      "sa_dst",
      scope,
    );

    expect(result.aiProfileApplied).toBe(true);
    const profile = written.find((w) => w.path.endsWith("aiAgent/profile"))!.data;
    expect(profile.systemPrompt).toBe("You are Velo from Velocity Fibre.");
    expect(profile.timezone).toBe("Africa/Johannesburg");
    // Must be filled in for the target before the agent can go live.
    expect(profile.businessName).toBe("");
    expect(profile.escalationNotifyEmail).toBeNull();
    expect(profile.websiteKb).toBeNull();
  });

  it("skips a custom-field key the target already defines", async () => {
    // The bug this guards: two definitions for the same key fight over the
    // same contact.customFields slot, and the loser's data silently vanishes.
    const { db, written } = fakeDb({
      collections: {
        "subAccounts/sa_dst/customFields": [
          { id: "existing", data: { entity: "contact", key: "install_date" } },
        ],
      },
      docs: {},
    });

    const result = await applySnapshot(
      db,
      {
        ...emptyPayload(),
        customFields: [
          { sourceId: "a", entity: "contact", key: "install_date", label: "Install date" },
          { sourceId: "b", entity: "contact", key: "isp_ref", label: "ISP reference" },
          // Same key, DIFFERENT entity — deals are a separate keyspace, so this
          // one must still be created.
          { sourceId: "c", entity: "deal", key: "install_date", label: "Install date" },
        ] as SnapshotPayload["customFields"],
      },
      "sa_dst",
      scope,
    );

    expect(result.customFieldsCreated).toBe(2);
    expect(result.customFieldsSkipped).toBe(1);
    const keys = written
      .filter((w) => w.path.includes("/customFields/"))
      .map((w) => `${w.data.entity}:${w.data.key}`);
    expect(keys.sort()).toEqual(["contact:isp_ref", "deal:install_date"]);
  });

  it("stamps the target's tenancy onto imported custom fields", async () => {
    const { db, written } = fakeDb({
      collections: { "subAccounts/sa_dst/customFields": [] },
      docs: {},
    });
    await applySnapshot(
      db,
      {
        ...emptyPayload(),
        customFields: [
          { sourceId: "a", entity: "contact", key: "k", label: "L" },
        ] as SnapshotPayload["customFields"],
      },
      "sa_dst",
      scope,
    );
    const field = written.find((w) => w.path.includes("/customFields/"))!.data;
    expect(field.subAccountId).toBe("sa_dst");
    expect(field.agencyId).toBe("ag_1");
    expect(field).not.toHaveProperty("sourceId");
  });
});

describe("applySnapshot — pipeline ids do not cross sub-accounts", () => {
  const scope = { agencyId: "ag_1", createdByUid: "u_1", snapshotId: "snap_1" };

  it("nulls trigger.pipelineId and move_stage.config.pipelineId, keeps the stage", async () => {
    const { db, written } = fakeDb({ collections: {}, docs: {} });
    await applySnapshot(
      db,
      {
        ...emptyPayload(),
        workflows: [
          {
            sourceId: "wf_src",
            name: "Pinned",
            status: "active",
            trigger: {
              type: "pipeline.stage.changed",
              filters: { all: [] },
              pipelineId: "src_pipeline",
              toStage: "qualified",
            },
            startNodeId: "n1",
            nodes: {
              n1: {
                id: "n1",
                type: "move_stage",
                config: { stage: "proposal", pipelineId: "src_pipeline" },
                next: null,
              },
            },
          },
        ] as unknown as SnapshotPayload["workflows"],
      },
      "sa_dst",
      scope,
    );
    const wf = written.find((w) => w.path.startsWith("workflows/"))!.data as {
      trigger: { pipelineId: string | null; toStage: string };
      nodes: Record<string, { config: Record<string, unknown> }>;
    };
    expect(wf.trigger.pipelineId).toBeNull();
    expect(wf.trigger.toStage).toBe("qualified");
    expect(wf.nodes.n1.config).toEqual({ stage: "proposal", pipelineId: null });
  });
});

describe("applySnapshot — task assignees do not cross sub-accounts", () => {
  const scope = { agencyId: "ag_1", createdByUid: "u_1", snapshotId: "snap_1" };

  it("nulls create_task.config.assignedToUid, keeps the rest of the step", async () => {
    const { db, written } = fakeDb({ collections: {}, docs: {} });
    await applySnapshot(
      db,
      {
        ...emptyPayload(),
        workflows: [
          {
            sourceId: "wf_src",
            name: "Assigned",
            status: "active",
            trigger: { type: "contact.tag.added", filters: { all: [] } },
            startNodeId: "n1",
            nodes: {
              n1: {
                id: "n1",
                type: "create_task",
                config: { title: "Call back", dueInDays: 2, assignedToUid: "u_src_member" },
                next: null,
              },
            },
          },
        ] as unknown as SnapshotPayload["workflows"],
      },
      "sa_dst",
      scope,
    );
    const wf = written.find((w) => w.path.startsWith("workflows/"))!.data as {
      nodes: Record<string, { config: Record<string, unknown> }>;
    };
    expect(wf.nodes.n1.config).toEqual({
      title: "Call back",
      dueInDays: 2,
      assignedToUid: null,
    });
  });
});

describe("applySnapshot — outbound destinations do not cross sub-accounts", () => {
  const scope = { agencyId: "ag_1", createdByUid: "u_1", snapshotId: "snap_1" };
  const applyNodes = async (nodes: Record<string, unknown>) => {
    const { db, written } = fakeDb({ collections: {}, docs: {} });
    await applySnapshot(
      db,
      {
        ...emptyPayload(),
        workflows: [{
          sourceId: "wf_src", name: "Notify", status: "active", startNodeId: "n1",
          trigger: { type: "contact.created", filters: { all: [] } }, nodes,
        }] as unknown as SnapshotPayload["workflows"],
      },
      "sa_dst",
      scope,
    );
    return (written.find((w) => w.path.startsWith("workflows/"))!.data as {
      nodes: Record<string, { config: Record<string, unknown> }>;
    }).nodes;
  };

  it("resets a custom notify recipient to the owner and drops the typed address", async () => {
    const nodes = await applyNodes({
      n1: { id: "n1", type: "notify", config: { recipient: "custom", to: "ops@client-a.example", subject: "Lead", body: "b" }, next: "n2" },
      n2: { id: "n2", type: "notify", config: { to: "legacy@client-a.example", subject: "L", body: "b" }, next: null },
      n3: { id: "n3", type: "notify", config: { recipient: "account_contact", to: "", subject: "A", body: "b" }, next: null },
    });
    expect(nodes.n1.config).toEqual({ recipient: "owner", to: "", subject: "Lead", body: "b" });
    // Legacy (no recipient) means custom — reset as well.
    expect(nodes.n2.config).toEqual({ recipient: "owner", to: "", subject: "L", body: "b" });
    // account_contact resolves on the TARGET at run time; nothing to strip.
    expect(nodes.n3.config.recipient).toBe("account_contact");
  });

  it("blanks a form's post-submit redirectUrl and keeps its other settings", async () => {
    const { db, written } = fakeDb({ collections: {}, docs: {} });
    await applySnapshot(
      db,
      {
        ...emptyPayload(),
        forms: [{
          sourceId: "f_src", name: "Lead", slug: "lead", enabled: true, fields: [],
          settings: { redirectUrl: "https://client-a.example/thanks", autoTags: ["lead"], thankYouMessage: "Thanks" },
        }] as unknown as SnapshotPayload["forms"],
      },
      "sa_dst",
      scope,
    );
    const form = written.find((w) => w.path.startsWith("forms/"))!.data as {
      settings: Record<string, unknown>;
    };
    expect(form.settings).toEqual({ redirectUrl: "", autoTags: ["lead"], thankYouMessage: "Thanks" });
  });

  it("blanks a webhook URL so the step is skipped until reconfigured", async () => {
    const nodes = await applyNodes({
      n1: { id: "n1", type: "webhook", config: { url: "https://client-a.example/hook" }, next: null },
    });
    expect(nodes.n1.config).toEqual({ url: "" });
  });
});

describe("applySnapshot — booking page slugs do not cross sub-accounts", () => {
  const scope = { agencyId: "ag_1", createdByUid: "u_1", snapshotId: "snap_1" };

  it("nulls trigger.bookingPageSlug on a booking.* trigger", async () => {
    const { db, written } = fakeDb({ collections: {}, docs: {} });
    await applySnapshot(
      db,
      {
        ...emptyPayload(),
        workflows: [
          {
            sourceId: "wf_src",
            name: "Page-pinned",
            status: "active",
            trigger: {
              type: "booking.no_show",
              filters: { all: [] },
              bookingPageSlug: "src_page",
            },
            startNodeId: "n1",
            nodes: {
              n1: { id: "n1", type: "add_tag", config: { tag: "x" }, next: null },
            },
          },
        ] as unknown as SnapshotPayload["workflows"],
      },
      "sa_dst",
      scope,
    );
    const wf = written.find((w) => w.path.startsWith("workflows/"))!.data as {
      trigger: { type: string; bookingPageSlug: string | null };
    };
    expect(wf.trigger.bookingPageSlug).toBeNull();
    expect(wf.trigger.type).toBe("booking.no_show");
  });
});
