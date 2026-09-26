import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { validateSnippet } from "@/lib/snippets/validate";
import { createSnippet, updateSnippet } from "@/lib/snippets/write";
import { templateRegistration } from "@/lib/comms/whatsapp/template-registrations";
import type { SnippetInput } from "@/types/snippets";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { agentActor, str } from "./helpers";
import { hasUnsafeText, lookAlikeProblem, messageBody, oneLine, UNSAFE_TEXT_MESSAGE } from "./text-safety";
import { recordProvenanceRows } from "./record-provenance";

/**
 * Snippets (saved replies) and the WhatsApp template list for API agents
 * (AGENT_API_V1_PLAN.md, PR10). A snippet is text a person may later send as
 * their own, so an agent's write is stamped (lastAgentEditAt / Key) and a
 * delete preview warns; the body must be a safe message body (line breaks
 * allowed, nothing invisible), the other fields visible one-line text.
 */

const snippetIdParam = { type: "string", description: "The snippet's id (from list_snippets)." };
const SNIPPET_PROPS = {
  name: { type: "string" },
  type: { type: "string", enum: ["text", "email"] },
  body: { type: "string", description: "May use merge tags, e.g. {{contact.firstName}}." },
  subject: { type: "string", description: "Email snippets only." },
  folder: { type: "string" },
};

/** The snippet as it would be stored, or an error (validateSnippet + visible text). */
function snippetInput(raw: unknown): { ok: true; value: SnippetInput } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  // The body as sent: normalised, line breaks kept, nothing invisible.
  const body = typeof r.body === "string" ? messageBody(r.body) : r.body;
  if (body === null) return { ok: false, error: `the body ${UNSAFE_TEXT_MESSAGE}` };
  const v = validateSnippet({ ...r, body });
  if (!v.ok) return v;
  for (const k of ["name", "subject", "folder"] as const) {
    const value = v.value[k];
    if (typeof value === "string" && hasUnsafeText(value)) return { ok: false, error: `the ${k} ${UNSAFE_TEXT_MESSAGE}` };
  }
  const mixed = lookAlikeProblem(v.value.name, []);
  if (mixed) return { ok: false, error: `the name ${mixed}` };
  return v;
}

/** Refuses a name that could pass for another snippet's in the sub-account. */
async function assertNameDistinct(subAccountId: string, name: string, selfId: string | null): Promise<void> {
  const snap = await getAdminDb().collection("snippets").where("subAccountId", "==", subAccountId).get();
  const problem = lookAlikeProblem(name, snap.docs.filter((d) => d.id !== selfId).map((d) => String(d.data().name ?? "")));
  if (problem) throw new CapabilityUserError(`The name ${problem} (another snippet's).`);
}

async function tenantSnippet(subAccountId: string, snippetId: unknown): Promise<FirebaseFirestore.DocumentData & { id: string }> {
  const snap = isDocId(snippetId) ? await getAdminDb().doc(`snippets/${snippetId}`).get() : null;
  const data = snap?.data();
  if (!data || data.subAccountId !== subAccountId) throw new CapabilityUserError("That snippet isn't in this workspace.");
  return { id: snap!.id, ...data };
}

export const SNIPPET_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_snippets",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "List the saved reply snippets",
    description: "List the sub-account's snippets (saved replies): id, name, type, folder, subject and body.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List snippets.",
    execute: async (ctx) => {
      const snap = await getAdminDb().collection("snippets").where("subAccountId", "==", ctx.subAccountId!).get();
      if (snap.empty) return { resultText: "No snippets." };
      const lines = snap.docs.map((d) => {
        const s = d.data();
        return `- ${oneLine(s.name)} — id: ${d.id}, ${s.type}${s.folder ? `, folder: ${oneLine(s.folder)}` : ""}${s.subject ? `, subject: ${oneLine(s.subject)}` : ""}\n  ${JSON.stringify(String(s.body ?? ""))}`;
      });
      return { resultText: `Snippets (${snap.size}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "create_snippet",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Create a saved reply snippet",
    description: "Create a snippet (a saved reply people insert into messages). Email snippets need a subject.",
    parameters: { type: "object", properties: SNIPPET_PROPS, required: ["name", "type", "body"], additionalProperties: false },
    validate: (raw) => {
      const v = snippetInput(raw);
      return v.ok ? { ok: true, args: { ...v.value } } : v;
    },
    summarize: (args) => `Create the snippet “${args.name}”.`,
    execute: async (ctx, args) => {
      await assertNameDistinct(ctx.subAccountId!, args.name as string, null);
      const id = await createSnippet({
        subAccountId: ctx.subAccountId!,
        createdByUid: ctx.uid,
        value: args as unknown as SnippetInput,
        actor: agentActor(ctx, "create_snippet"),
      });
      if (!id) throw new CapabilityUserError("This workspace wasn't found.");
      return { resultText: `Created the snippet (id: ${id}).`, ref: { kind: "snippet", id } };
    },
  },
  {
    name: "update_snippet",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Replace a snippet",
    description: "Replace a snippet's name, type, body, subject and folder (send them all, as list_snippets shows them).",
    parameters: { type: "object", properties: { snippetId: snippetIdParam, ...SNIPPET_PROPS }, required: ["snippetId", "name", "type", "body"], additionalProperties: false },
    validate: (raw) => {
      const snippetId = str(raw, "snippetId");
      if (!isDocId(snippetId)) return { ok: false, error: "a snippetId is required" };
      const v = snippetInput(raw);
      return v.ok ? { ok: true, args: { snippetId, ...v.value } } : v;
    },
    summarize: (args) => `Replace the snippet ${args.snippetId}.`,
    execute: async (ctx, args) => {
      const { snippetId, ...value } = args;
      const s = await tenantSnippet(ctx.subAccountId!, snippetId);
      await assertNameDistinct(ctx.subAccountId!, value.name as string, s.id);
      await updateSnippet(s.id, value as unknown as SnippetInput, agentActor(ctx, "update_snippet"));
      return { resultText: "Updated the snippet.", ref: { kind: "snippet", id: s.id } };
    },
  },
  {
    name: "delete_snippet",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    approval: "hard_delete",
    menuLabel: "Delete a snippet (a person approves)",
    description: "Delete a snippet. Queued for a sub-account admin to approve.",
    parameters: { type: "object", properties: { snippetId: snippetIdParam }, required: ["snippetId"], additionalProperties: false },
    validate: (raw) => {
      const snippetId = str(raw, "snippetId");
      return isDocId(snippetId) ? { ok: true, args: { snippetId } } : { ok: false, error: "a snippetId is required" };
    },
    summarize: () => "Delete a snippet.",
    approvalTarget: async (ctx, args) => {
      await tenantSnippet(ctx.subAccountId!, args.snippetId);
      return { contactId: null, territoryId: null, scoped: false };
    },
    preview: async (ctx, args) => {
      const s = await tenantSnippet(ctx.subAccountId!, args.snippetId);
      const body = messageBody(String(s.body ?? ""));
      return [
        { label: "Delete snippet", value: `${oneLine(s.name) || "(unnamed)"} (${s.type})` },
        ...recordProvenanceRows(s.id, s),
        ...(s.subject ? [{ label: "Subject", value: String(s.subject) }] : []),
        body !== null ? { label: "Body", value: body, multiline: true as const } : { label: "Body", value: oneLine(s.body) },
      ];
    },
    execute: async (ctx, args) => {
      const s = await tenantSnippet(ctx.subAccountId!, args.snippetId);
      await getAdminDb().doc(`snippets/${s.id}`).delete();
      return { resultText: "Deleted the snippet.", ref: { kind: "snippet", id: s.id } };
    },
  },
  {
    name: "list_whatsapp_templates",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "List the WhatsApp message templates",
    description: "List the sub-account's WhatsApp templates for send_whatsapp_template: id, name, language, approval per rail, body and variables.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List WhatsApp templates.",
    execute: async (ctx) => {
      const snap = await getAdminDb().collection(`subAccounts/${ctx.subAccountId}/whatsappTemplates`).get();
      if (snap.empty) return { resultText: "No WhatsApp templates." };
      const lines = snap.docs.map((d) => {
        const t = d.data() as WhatsappTemplateDoc;
        const rails = (["twilio", "cloud"] as const).map((p) => `${p}: ${templateRegistration(t, p)?.status ?? "none"}`).join(", ");
        const vars = (t.variables ?? []).map((v) => `{{${v.position}}} ${oneLine(v.label)} (${v.source === "merge_tag" ? v.mergeTag : "you give it"})`).join("; ");
        return `- ${oneLine(t.displayName || t.name)} — id: ${d.id}, name: ${oneLine(t.name)}, ${t.language}, ${rails}\n  ${JSON.stringify(String(t.body ?? ""))}${vars ? `\n  variables: ${vars}` : ""}`;
      });
      return { resultText: `WhatsApp templates (${snap.size}):\n${lines.join("\n")}` };
    },
  },
];
