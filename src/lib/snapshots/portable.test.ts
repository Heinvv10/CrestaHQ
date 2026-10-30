import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { applySnapshot } from "./apply";
import { toPortablePayload } from "./portable";
import type { SnapshotPayload } from "@/types/snapshots";

/**
 * The cross-agency import scrub: nothing in the stored copy may send the
 * importer's data to a destination the sharer chose, or name a document in the
 * sharer's tenant — while apply must still link an imported form to the
 * workflow it triggers.
 */

const SOURCE_FORM = "form_src_7Q";
const SOURCE_TEMPLATE = "tmpl_src_9Z";

function sourcePayload(): SnapshotPayload {
  return {
    forms: [{ sourceId: SOURCE_FORM, name: "Lead form", settings: { redirectUrl: "https://source.example/thanks", autoTags: ["lead"] } }],
    messageTemplates: [{ sourceId: "msg_src_3K", name: "Hi" }],
    products: [{ sourceId: "prod_src_4M", name: "Call-out" }],
    customFields: [{ sourceId: "cf_src_5N", entity: "contact", key: "k", label: "K" }],
    workflows: [
      {
        sourceId: "wf_src_6P",
        name: "Lead flow",
        trigger: {
          type: "form.submitted",
          filters: { all: [] },
          formId: SOURCE_FORM,
          linkId: "link_src_8R",
          pipelineId: "pipe_src_2S",
        },
        nodes: {
          n1: { id: "n1", type: "notify", config: { recipient: "custom", to: "leak@source.example", subject: "New lead", body: "b" } },
          n2: { id: "n2", type: "webhook", config: { url: "https://source.example/collect" } },
          n3: { id: "n3", type: "whatsapp_template", config: { templateId: SOURCE_TEMPLATE, senderId: "sender_src_1T" } },
          n4: { id: "n4", type: "send_whatsapp", config: { body: "hello", templateId: "tmpl_src_0U" } },
        },
      },
    ],
  } as unknown as SnapshotPayload;
}

const scrubbed = () => toPortablePayload(sourcePayload(), new Set());
const nodes = (p: SnapshotPayload) => p.workflows[0].nodes as Record<string, { config: Record<string, unknown> }>;

describe("toPortablePayload — outbound destinations", () => {
  it("resets a custom notify recipient to the importer's owner and clears the address", () => {
    const n1 = nodes(scrubbed()).n1.config;
    expect(n1.recipient).toBe("owner");
    expect(n1.to).toBe("");
    expect(n1.subject).toBe("New lead");
  });

  it("blanks a form's post-submit redirect and keeps its other settings", () => {
    const settings = scrubbed().forms[0].settings as unknown as Record<string, unknown>;
    expect(settings.redirectUrl).toBe("");
    expect(settings.autoTags).toEqual(["lead"]);
  });

  it("blanks a webhook URL", () => {
    expect(nodes(scrubbed()).n2.config.url).toBe("");
  });

  it("nulls WhatsApp template and sender ids", () => {
    const n = nodes(scrubbed());
    expect(n.n3.config).toMatchObject({ templateId: null, senderId: null });
    expect(n.n4.config).toMatchObject({ templateId: null, body: "hello" });
  });

  it("leaves no source destination or source doc id anywhere in the copy", () => {
    const body = JSON.stringify(scrubbed());
    for (const leak of [
      "leak@source.example", "source.example/collect", "source.example/thanks", SOURCE_FORM, SOURCE_TEMPLATE,
      "sender_src_1T", "tmpl_src_0U", "msg_src_3K", "prod_src_4M", "cf_src_5N",
      "wf_src_6P", "link_src_8R", "pipe_src_2S",
    ]) {
      expect(body, `copy still carries ${leak}`).not.toContain(leak);
    }
  });
});

describe("toPortablePayload — form ids", () => {
  it("re-mints the form id and points the trigger at the new one", () => {
    const p = scrubbed();
    expect(p.forms[0].sourceId).not.toBe(SOURCE_FORM);
    expect(p.workflows[0].trigger.formId).toBe(p.forms[0].sourceId);
  });

  it("nulls a trigger form id the snapshot does not carry", () => {
    const src = sourcePayload();
    src.forms = [];
    expect(toPortablePayload(src, new Set()).workflows[0].trigger.formId).toBeNull();
  });

  it("still lets apply link the imported form to its workflow", async () => {
    const written: { path: string; data: Record<string, unknown> }[] = [];
    let auto = 0;
    const collection = (path: string) => ({
      get: async () => ({ docs: [] }),
      doc: () => {
        const id = `new_${++auto}`;
        // Custom-field definitions are written one by one with create().
        return { id, path: `${path}/${id}`, create: async (data: Record<string, unknown>) => void written.push({ path: `${path}/${id}`, data }) };
      },
    });
    const db = {
      collection,
      doc: (path: string) => ({
        id: path.split("/").pop()!,
        path,
        get: async () => ({ exists: false, data: () => undefined }),
        set: async (data: Record<string, unknown>) => void written.push({ path, data }),
      }),
      // Nothing pre-exists at any deterministic id in this test.
      getAll: async (...refs: { path: string }[]) =>
        refs.map((ref) => ({ ref, exists: false, data: () => undefined })),
      batch: () => ({
        set: (ref: { path: string }, data: Record<string, unknown>) => void written.push({ path: ref.path, data }),
        commit: async () => undefined,
      }),
    } as unknown as Firestore;

    const result = await applySnapshot(db, scrubbed(), "sa_dst", {
      agencyId: "ag_dst",
      createdByUid: "u_dst",
      snapshotId: "snap_dst",
    });

    const form = written.find((w) => w.path.startsWith("forms/"))!;
    const workflow = written.find((w) => w.path.startsWith("workflows/"))!;
    expect(result.workflowsLinked).toBe(1);
    expect((workflow.data.trigger as { formId: string }).formId).toBe(form.data.id);
  });
});
