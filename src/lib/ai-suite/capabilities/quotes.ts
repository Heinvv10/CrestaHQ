import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import { canonical } from "@/lib/server/agent-proposals-encoding";
import { checkDealLink, createQuote, sanitizePayload } from "@/lib/server/quote-write";
import { sendClaimFresh } from "@/lib/server/quote-send-claim";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import type { Quote } from "@/types/quotes";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { agentActor, fmtMoney, str, toDate } from "./helpers";
import { oneLine } from "./text-safety";
import { recordProvenanceRows } from "./record-provenance";
import { assertTenantProducts, QUOTE_FIELD_KEYS, QUOTE_FIELD_PROPS, quoteFields } from "./quote-fields";
import { docLabel, quoteIdParam, quoteRows, tenantQuote, totalCents, type TenantQuote } from "./quote-support";

/**
 * Quotes and invoices for API agents (AGENT_API_V1_PLAN.md, PR11): list and
 * read; create a draft through the quotes route's own writer; edit a draft
 * directly. An edit of one already sent (or accepted, viewed...) changes what
 * the customer sees and pays on its link, so a person approves it (spend),
 * with every asked field old -> new and the stored values pinned and re-checked
 * in the write's transaction. Sending and marking paid: quote-send.ts,
 * quote-paid.ts.
 */

const LIST_CAP = 100;
const total = (q: Quote) => fmtMoney(computeQuoteTotals(q).total, q.currency || "USD");

/** The stored value of each asked field (validUntil as its instant). */
const valuesOf = (q: FirebaseFirestore.DocumentData, patch: Record<string, unknown>) =>
  Object.fromEntries(Object.keys(patch).sort().map((k) => [k, k === "validUntil" ? (toDate(q[k])?.toISOString() ?? null) : (q[k] ?? null)]));

const PAY_LINK_REFUSAL = "This invoice's emailed pay link charges the old amount; void it and send a new invoice.";
type QueryGet = (q: FirebaseFirestore.Query) => Promise<FirebaseFirestore.QuerySnapshot>;

/** Would the patch change what it charges, while an emailed pay link (a pay
 *  URL on it, or an open Paystack link for it) still charges the old amount? */
async function repricesLiveLink(subAccountId: string, id: string, q: FirebaseFirestore.DocumentData, patch: Record<string, unknown>, get: QueryGet = (x) => x.get()) {
  const next = { ...q, ...patch } as Quote;
  const cur = (x: FirebaseFirestore.DocumentData) => String(x.currency ?? "").toUpperCase();
  if (totalCents(next) === totalCents(q as Quote) && cur(next) === cur(q)) return false;
  if (q.paymentLinkUrl || q.paymentLinkId) return true;
  const links = await get(getAdminDb().collection("paymentLinks").where("subAccountId", "==", subAccountId).where("invoiceId", "==", id).where("status", "==", "open"));
  return links.docs.some((d) => d.data().active !== false);
}

/** The checked fields (numbered line ids), whoever calls. */
function checkedFields(fields: Record<string, unknown>): Record<string, unknown> {
  const f = quoteFields(fields);
  if (!f.ok) throw new CapabilityUserError(f.error);
  return f.args;
}

async function checkLinks(subAccountId: string, contactId: string, args: Record<string, unknown>): Promise<void> {
  await assertTenantProducts(subAccountId, args.lineItems);
  if (isDocId(args.dealId)) {
    const linked = await checkDealLink(subAccountId, args.dealId, contactId);
    if (!linked.ok) throw new CapabilityUserError(`${linked.error}.`);
  }
}

export const QUOTE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_quotes",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "List quotes and invoices",
    description: "List quotes and invoices, newest first: id, number, kind, status, contact and total. Optionally only one contact's, or one status.",
    parameters: {
      type: "object",
      properties: {
        contactId: { type: "string" },
        status: { type: "string", enum: ["draft", "sent", "viewed", "accepted", "declined", "expired", "paid"] },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const [contactId, status] = [str(raw, "contactId"), str(raw, "status")];
      if (contactId && !isDocId(contactId)) return { ok: false, error: "contactId must be a contact's id" };
      return { ok: true, args: { ...(contactId ? { contactId } : {}), ...(status ? { status } : {}) } };
    },
    summarize: () => "List quotes.",
    execute: async (ctx, args) => {
      let q: FirebaseFirestore.Query = getAdminDb().collection("quotes").where("subAccountId", "==", ctx.subAccountId!);
      if (args.contactId) q = q.where("contactId", "==", args.contactId);
      if (args.status) q = q.where("status", "==", args.status);
      const snap = await q.limit(500).get();
      const rows = snap.docs
        .map((d) => ({ ...(d.data() as Quote), id: d.id }))
        .sort((a, b) => (toDate(b.createdAt)?.getTime() ?? 0) - (toDate(a.createdAt)?.getTime() ?? 0));
      if (!rows.length) return { resultText: "No quotes or invoices." };
      const lines = rows.slice(0, LIST_CAP).map((r) => `- ${docLabel(r)} ${oneLine(r.quoteNumber)} \u2014 id: ${r.id}, ${r.status}, contact ${r.contactId}, ${total(r)}`);
      return { resultText: `Quotes and invoices (${rows.length}):\n${lines.join("\n")}`, ...(rows.length > LIST_CAP ? { truncated: true as const } : {}) };
    },
  },
  {
    name: "get_quote",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "Read a quote or invoice",
    description: "Read one quote or invoice: status, contact, lines, totals, terms, dates and linked deal.",
    parameters: { type: "object", properties: { quoteId: quoteIdParam }, required: ["quoteId"], additionalProperties: false },
    validate: (raw) => {
      const quoteId = str(raw, "quoteId");
      return isDocId(quoteId) ? { ok: true, args: { quoteId } } : { ok: false, error: "a quoteId is required" };
    },
    summarize: () => "Read a quote.",
    execute: async (ctx, args) => {
      const q = await tenantQuote(ctx.subAccountId!, args.quoteId);
      const when = (v: unknown) => toDate(v)?.toISOString() ?? "never";
      const text = [
        ...quoteRows(q).map((r) => `${r.label}: ${r.value}`),
        `Contact: ${q.contactId}`,
        `Currency: ${q.currency}`,
        `Terms and notes: ${oneLine(q.termsAndNotes) || "(none)"}`,
        `Valid until: ${toDate(q.validUntil)?.toISOString().slice(0, 10) ?? "(none)"}`,
        `Payment due days: ${q.paymentDueDays ?? "(none)"}`,
        `Linked deal: ${q.dealId ?? "(none)"}`,
        `Sent: ${when(q.sentAt)}; paid: ${when(q.paidAt)}`,
      ];
      return { resultText: text.join("\n") };
    },
  },
  {
    name: "create_quote",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Draft a quote or invoice",
    description: "Draft a quote (or invoice, kind:\"invoice\") for a contact, with at least one line. Nothing is sent: use send_quote.",
    parameters: {
      type: "object",
      properties: { contactId: { type: "string" }, kind: { type: "string", enum: ["quote", "invoice"] }, ...QUOTE_FIELD_PROPS },
      required: ["contactId", "lineItems"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const contactId = str(raw, "contactId");
      if (!isDocId(contactId)) return { ok: false, error: "a contactId is required" };
      const f = quoteFields(raw);
      if (!f.ok) return f;
      if (!f.args.lineItems) return { ok: false, error: "at least one line is required" };
      const kind = str(raw, "kind") === "invoice" ? "invoice" : "quote";
      return { ok: true, args: { contactId, kind, ...f.args } };
    },
    summarize: (args) => `Draft a ${args.kind}.`,
    execute: async (ctx, args) => {
      const contactId = args.contactId as string;
      const contact = (await getAdminDb().doc(`contacts/${contactId}`).get()).data();
      if (!contact || contact.subAccountId !== ctx.subAccountId) throw new CapabilityUserError("That contact isn't in this workspace.");
      await checkLinks(ctx.subAccountId!, contactId, args);
      const created = await createQuote({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        createdByUid: ctx.uid,
        contactId,
        contact,
        body: args,
        actor: agentActor(ctx, "create_quote"),
      });
      if (!created.ok) throw new CapabilityUserError(created.error);
      return { resultText: `Drafted ${args.kind} ${created.quoteNumber} (id: ${created.id}).`, ref: { kind: "quote", id: created.id } };
    },
  },
  {
    name: "update_quote",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Edit a quote or invoice",
    description: "Edit a quote's or invoice's lines, currency, discount, tax, terms, billing details, dates or linked deal. Editing one that isn't a draft any more is queued for a person to approve.",
    parameters: { type: "object", properties: { quoteId: quoteIdParam, ...QUOTE_FIELD_PROPS }, required: ["quoteId"], additionalProperties: false },
    validate: (raw) => {
      const quoteId = str(raw, "quoteId");
      if (!isDocId(quoteId)) return { ok: false, error: "a quoteId is required" };
      const f = quoteFields(raw);
      if (!f.ok) return f;
      if (!Object.keys(f.args).length) return { ok: false, error: `give at least one of ${QUOTE_FIELD_KEYS.join(", ")}` };
      return { ok: true, args: { quoteId, ...f.args } };
    },
    summarize: (args) => `Edit the quote ${args.quoteId}.`,
    // The customer's link shows (and pays) the live document.
    approvalFor: async (args, ctx) => ((await tenantQuote(ctx.subAccountId!, args.quoteId)).status === "draft" ? undefined : "spend"),
    approvalHint: { approval: "spend", when: "the quote or invoice is no longer a draft" },
    approvalTarget: async (ctx, args) => {
      const q = await tenantQuote(ctx.subAccountId!, args.quoteId);
      return { contactId: isDocId(q.contactId) ? q.contactId : null, territoryId: q.territoryId ?? null, scoped: true };
    },
    preview: async (ctx, args) => {
      const q = await tenantQuote(ctx.subAccountId!, args.quoteId);
      if (q.status === "paid") throw new CapabilityUserError(`That ${docLabel(q).toLowerCase()} is already paid.`);
      const { quoteId: _id, ...fields } = args;
      const patch = sanitizePayload(checkedFields(fields));
      if (await repricesLiveLink(ctx.subAccountId!, q.id, q, patch)) throw new CapabilityUserError(PAY_LINK_REFUSAL);
      const next: TenantQuote = { ...q, ...patch };
      const shown = (x: TenantQuote) => new Map(quoteRows(x).map((r) => [r.label, r.value]));
      const [before, after] = [shown(q), shown(next)];
      const plain: Record<string, (x: TenantQuote) => unknown> = {
        currency: (x) => x.currency,
        termsAndNotes: (x) => oneLine(x.termsAndNotes) || "(none)",
        billedToOrganization: (x) => oneLine(x.billedToOrganization) || "(none)",
        billingAddress: (x) => oneLine(x.billingAddress) || "(none)",
        validUntil: (x) => toDate(x.validUntil)?.toISOString().slice(0, 10) ?? "(none)",
        paymentDueDays: (x) => x.paymentDueDays ?? "(none)",
        autoCreateDealOnAccept: (x) => x.autoCreateDealOnAccept === true,
        dealId: (x) => x.dealId ?? "(none)",
        globalTaxPercent: (x) => (x.globalTaxPercent == null ? "(none)" : `${x.globalTaxPercent}%`),
        globalDiscount: (x) => (x.globalDiscount ? `${x.globalDiscount.value}${x.globalDiscount.type === "percent" ? "%" : ` ${x.currency}`}` : "(none)"),
      };
      const changes = Object.keys(patch)
        .filter((k) => k in plain)
        .map((k) => {
          const [a, b] = [String(plain[k](q)), String(plain[k](next))];
          return { label: k, value: a === b ? `${a} (unchanged)` : `${a} \u2192 ${b}` };
        });
      return {
        rows: [
          { label: "Edit", value: `${docLabel(q)} ${oneLine(q.quoteNumber)} (${q.status}): the customer's link shows the new version` },
          ...recordProvenanceRows(q.id, q),
          ...(patch.lineItems ? [{ label: "Line items now", value: before.get("Line items")!, multiline: true as const }, { label: "Line items after", value: after.get("Line items")!, multiline: true as const }] : []),
          ...changes,
          { label: "Total", value: before.get("Total") === after.get("Total") ? `${before.get("Total")} (unchanged)` : `${before.get("Total")} \u2192 ${after.get("Total")}` },
        ],
        pinned: { quoteId: q.id, status: q.status, before: valuesOf(q, patch) },
      };
    },
    execute: async (ctx, args) => {
      const { quoteId, ...fields } = args;
      const q = await tenantQuote(ctx.subAccountId!, quoteId);
      await checkLinks(ctx.subAccountId!, q.contactId, fields);
      const patch = sanitizePayload(checkedFields(fields));
      const db = getAdminDb();
      const ref = db.doc(`quotes/${q.id}`);
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        if (!current || current.subAccountId !== ctx.subAccountId) throw new CapabilityUserError("That quote or invoice isn't in this workspace.");
        // Not while its email is going out: the link must show what the email says.
        if (sendClaimFresh(current)) throw new CapabilityUserError("It is being sent right now, so it wasn't changed; try again in a minute.");
        if (ctx.approved) {
          const pinned = ctx.approved.pinned ?? {};
          if (current.status !== pinned.status || canonical(valuesOf(current, patch)) !== canonical(pinned.before)) {
            throw new CapabilityUserError("The quote or invoice changed since this was reviewed; nothing was changed.");
          }
        } else if (current.status !== "draft") {
          throw new CapabilityUserError("It is no longer a draft, so this edit needs approval: send it again.");
        }
        if (await repricesLiveLink(ctx.subAccountId!, q.id, current, patch, (x) => tx.get(x))) throw new CapabilityUserError(PAY_LINK_REFUSAL);
        tx.update(ref, { ...patch, updatedAt: FieldValue.serverTimestamp(), ...agentEditStamp(agentActor(ctx, "update_quote")) });
      });
      return { resultText: `Updated ${docLabel(q).toLowerCase()} ${q.quoteNumber}.`, ref: { kind: "quote", id: q.id } };
    },
  },
];
