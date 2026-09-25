import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import {
  createCompanyServerSide,
  deleteCompanyAndUnlinkContacts,
  updateCompanyServerSide,
} from "@/lib/server/companies-service";
import type { CompanyFormData } from "@/types/companies";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { EMAIL_RE, str, agentActor, oneLine, UNSAFE_TEXT_RE } from "./helpers";
import { recordProvenanceRows } from "./record-provenance";

/**
 * Companies for API agents (AGENT_API_V1_PLAN.md, PR7b). Every model-supplied
 * company id passes isDocId and is re-anchored to `ctx.subAccountId` before
 * anything is read or written. Only the dashboard form's fields are writable;
 * tenancy keys and timestamps come from the ctx and the service.
 */

/** The fields the dashboard's company form edits — nothing else is writable. */
const COMPANY_FIELDS = ["name", "phone", "email", "website", "address"] as const;
const MAX_FIELD = 500;
/** list_companies reads at most this many companies. */
const LIST_CAP = 500;

/** The company, or a CapabilityUserError when it is not in `subAccountId`. */
async function tenantCompany(subAccountId: string, companyId: unknown): Promise<FirebaseFirestore.DocumentData> {
  const data = isDocId(companyId) ? (await getAdminDb().doc(`companies/${companyId}`).get()).data() : undefined;
  if (!data || data.subAccountId !== subAccountId) {
    throw new CapabilityUserError("That company isn't in this workspace.");
  }
  return data;
}

/** The allowlisted fields present in `raw`, trimmed; an error on bad input. */
function companyFields(raw: unknown): { ok: true; data: Partial<CompanyFormData> } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const data: Partial<CompanyFormData> = {};
  for (const k of COMPANY_FIELDS) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== "string") return { ok: false, error: `${k} must be text` };
    if (UNSAFE_TEXT_RE.test(r[k] as string)) return { ok: false, error: `${k} can't contain control or bidi characters` };
    const v = str(raw, k);
    if (v.length > MAX_FIELD) return { ok: false, error: `${k} must be at most ${MAX_FIELD} characters` };
    data[k] = v;
  }
  if (data.name === "") return { ok: false, error: "a company name can't be empty" };
  if (data.email && !EMAIL_RE.test(data.email)) return { ok: false, error: "that email address doesn't look valid" };
  return { ok: true, data };
}

const fieldProps = {
  name: { type: "string", description: "Company name." },
  phone: { type: "string" },
  email: { type: "string" },
  website: { type: "string" },
  address: { type: "string" },
};
const companyIdParam = { type: "string", description: "The company's id (from list_companies)." };

const linkedContacts = (subAccountId: string, companyId: string) =>
  getAdminDb()
    .collection("contacts")
    .where("subAccountId", "==", subAccountId)
    .where("companyId", "==", companyId)
    .count()
    .get()
    .then((r) => r.data().count);

export const COMPANY_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_companies",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "List this workspace's companies",
    description: "List the companies in this sub-account (name, id, phone, email, website), optionally filtered by a name fragment.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Optional name fragment." } },
      additionalProperties: false,
    },
    validate: (raw) => ({ ok: true, args: { query: str(raw, "query").slice(0, 120) } }),
    summarize: () => "List companies.",
    execute: async (ctx, args) => {
      const q = (args.query as string).toLowerCase();
      // Capped BEFORE the name filter: a match past the first LIST_CAP is
      // not found, so a capped result says it may be incomplete.
      const snap = await getAdminDb().collection("companies").where("subAccountId", "==", ctx.subAccountId!).limit(LIST_CAP + 1).get();
      const capped = snap.size > LIST_CAP;
      const note = capped
        ? `Showing the first ${LIST_CAP} companies; this list may be incomplete, so a name may exist that isn't shown.`
        : "";
      const rows = snap.docs
        .slice(0, LIST_CAP)
        .map((d) => ({ id: d.id, ...d.data() }) as { id: string } & Partial<CompanyFormData>)
        .filter((c) => !q || String(c.name ?? "").toLowerCase().includes(q))
        .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")))
        .slice(0, 50);
      const flag = capped ? { truncated: true as const } : {};
      if (rows.length === 0) {
        const none = q ? `No companies matched “${args.query}”.` : "No companies yet.";
        return { resultText: [none, note].filter(Boolean).join(" "), ...flag };
      }
      return {
        ...flag,
        resultText: (note ? `${note}\n` : "") + rows
          .map((c) => {
            const bits = [
              c.phone && `phone: ${oneLine(c.phone)}`,
              c.email && `email: ${oneLine(c.email)}`,
              c.website && `website: ${oneLine(c.website)}`,
            ].filter(Boolean);
            return `- ${oneLine(c.name) || "(unnamed)"} — id: ${c.id}${bits.length ? ` (${bits.join(", ")})` : ""}`;
          })
          .join("\n"),
      };
    },
  },
  {
    name: "create_company",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Add a company",
    description:
      "Add a company to this sub-account. Check list_companies first to avoid a duplicate — but when it says its list may be incomplete, a matching name can exist that it didn't show.",
    parameters: { type: "object", properties: fieldProps, required: ["name"], additionalProperties: false },
    validate: (raw) => {
      const f = companyFields(raw);
      if (!f.ok) return f;
      if (!f.data.name) return { ok: false, error: "a company name is required" };
      return { ok: true, args: { name: "", phone: "", email: "", website: "", address: "", ...f.data } };
    },
    summarize: (args) => `Add the company “${args.name}”.`,
    execute: async (ctx, args) => {
      const id = await createCompanyServerSide({
        agencyId: ctx.agencyId,
        subAccountId: ctx.subAccountId!,
        createdByUid: ctx.uid,
        data: args as unknown as CompanyFormData,
        actor: agentActor(ctx, "create_company"),
      });
      return { resultText: `Added the company “${args.name}”.`, ref: { kind: "company", id } };
    },
  },
  {
    name: "update_company",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Edit a company",
    description:
      "Edit a company's name, phone, email, website or address. Contacts linked to it keep the company name they were linked with.",
    parameters: {
      type: "object",
      properties: { companyId: companyIdParam, ...fieldProps },
      required: ["companyId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const companyId = str(raw, "companyId");
      if (!companyId) return { ok: false, error: "a companyId is required" };
      const f = companyFields(raw);
      if (!f.ok) return f;
      if (Object.keys(f.data).length === 0) return { ok: false, error: "nothing to change" };
      return { ok: true, args: { companyId, ...f.data } };
    },
    summarize: (args) => `Update a company's ${Object.keys(args).filter((k) => k !== "companyId").join(", ")}.`,
    execute: async (ctx, args) => {
      const { companyId, ...data } = args;
      await tenantCompany(ctx.subAccountId!, companyId);
      const ok = await updateCompanyServerSide({
        companyId: companyId as string,
        subAccountId: ctx.subAccountId!,
        data: data as Partial<CompanyFormData>,
        actor: agentActor(ctx, "update_company"),
      });
      if (!ok) throw new CapabilityUserError("That company isn't in this workspace.");
      return { resultText: "Updated the company.", ref: { kind: "company", id: companyId as string } };
    },
  },
  {
    name: "delete_company",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    approval: "hard_delete",
    menuLabel: "Delete a company (a person approves)",
    description:
      "Delete a company. Its contacts stay, unlinked from it (they keep the company name as text). Queued for a sub-account admin to approve.",
    parameters: { type: "object", properties: { companyId: companyIdParam }, required: ["companyId"], additionalProperties: false },
    validate: (raw) => {
      const companyId = str(raw, "companyId");
      return companyId ? { ok: true, args: { companyId } } : { ok: false, error: "a companyId is required" };
    },
    summarize: () => "Delete a company.",
    // Companies carry no territory: the approval is tenant-wide.
    approvalTarget: async (ctx, args) => {
      await tenantCompany(ctx.subAccountId!, args.companyId);
      return { contactId: null, territoryId: null, scoped: false };
    },
    preview: async (ctx, args) => {
      const c = await tenantCompany(ctx.subAccountId!, args.companyId);
      const linked = await linkedContacts(ctx.subAccountId!, args.companyId as string);
      // One line per value: a stored newline must not fake a row.
      return [
        { label: "Delete company", value: String(c.name || "(unnamed)") },
        ...recordProvenanceRows(args.companyId as string, c),
        { label: "Contacts unlinked", value: `${linked} (they stay, keeping the company name as text)` },
      ].map((r) => ({ ...r, value: oneLine(r.value) }));
    },
    execute: async (ctx, args) => {
      await tenantCompany(ctx.subAccountId!, args.companyId);
      const unlinked = await deleteCompanyAndUnlinkContacts(getAdminDb(), args.companyId as string, ctx.subAccountId!);
      return {
        resultText: `Deleted the company; ${unlinked} contact${unlinked === 1 ? "" : "s"} unlinked.`,
        ref: { kind: "company", id: args.companyId as string },
      };
    },
  },
];
