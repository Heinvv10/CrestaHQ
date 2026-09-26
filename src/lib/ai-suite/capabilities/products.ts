import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import { sanitizeProductPayload } from "@/lib/products/sanitize";
import { createProduct } from "@/lib/products/write";
import { productSellers, productUsage } from "@/lib/products/usage";
import type { Product } from "@/types/products";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { agentActor, fmtMoney, str } from "./helpers";
import { hasUnsafeText, oneLine, UNSAFE_TEXT_MESSAGE } from "./text-safety";
import { recordProvenanceRows } from "./record-provenance";

/**
 * Catalog products for API agents (AGENT_API_V1_PLAN.md, PR10): list,
 * create / update as direct writes (the products route's own sanitizer and
 * writer) — except a price, currency or active change to a product a
 * checkout page or funnel sells, which a person approves — and delete
 * approved, refused while anything sells the product (it would break that
 * checkout). Text fields must be visible text.
 */

const productIdParam = { type: "string", description: "The product's id (from list_products)." };
const TEXT_FIELDS = ["name", "description", "bumpHeadline"] as const;
const PRODUCT_PROPS = {
  name: { type: "string" },
  description: { type: "string" },
  unitPriceCents: { type: "number", description: "Whole cents, e.g. 49900 for 499.00." },
  currency: { type: "string", description: "3-letter code." },
  active: { type: "boolean", description: "false archives it (hidden from pickers)." },
  bumpEligible: { type: "boolean" },
  bumpHeadline: { type: "string" },
};

const MONEY = ["unitPriceCents", "currency", "active"] as const;
const touchesMoney = (args: Record<string, unknown>) => MONEY.some((k) => args[k] !== undefined);
/** What a buyer pays for it, as stored. */
const moneyOf = (p: FirebaseFirestore.DocumentData) => ({
  unitPriceCents: p.unitPriceCents ?? 0,
  currency: p.currency ?? "USD",
  active: p.active !== false,
});

/** The sanitized payload of the args, or an error for hidden text / bad values. */
function productFields(raw: unknown): { ok: true; fields: Partial<Product> } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  for (const k of TEXT_FIELDS) {
    if (r[k] !== undefined && typeof r[k] !== "string") return { ok: false, error: `${k} must be text` };
    if (typeof r[k] === "string" && hasUnsafeText(r[k] as string)) return { ok: false, error: `${k} ${UNSAFE_TEXT_MESSAGE}` };
  }
  if (r.unitPriceCents !== undefined && (typeof r.unitPriceCents !== "number" || !Number.isFinite(r.unitPriceCents) || r.unitPriceCents < 0)) {
    return { ok: false, error: "unitPriceCents must be a whole number of cents, 0 or more" };
  }
  if (r.currency !== undefined && (typeof r.currency !== "string" || !/^[A-Za-z]{3}$/.test(r.currency))) {
    return { ok: false, error: "currency must be a 3-letter code" };
  }
  return { ok: true, fields: sanitizeProductPayload(r) };
}

async function tenantProduct(subAccountId: string, productId: unknown): Promise<Product> {
  const snap = isDocId(productId) ? await getAdminDb().doc(`products/${productId}`).get() : null;
  const data = snap?.data();
  if (!data || data.subAccountId !== subAccountId) throw new CapabilityUserError("That product isn't in this workspace.");
  return { id: snap!.id, ...(data as Omit<Product, "id">) };
}

export const PRODUCT_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_products",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "List the product catalog",
    description: "List the sub-account's products: id, name, price, currency and whether each is active.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List products.",
    execute: async (ctx) => {
      const snap = await getAdminDb().collection("products").where("subAccountId", "==", ctx.subAccountId!).get();
      const products = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Product, "id">) })).sort((a, b) => a.name.localeCompare(b.name));
      if (!products.length) return { resultText: "No products." };
      const lines = products.map(
        (p) => `- ${oneLine(p.name) || "(unnamed)"} — id: ${p.id}, ${fmtMoney((p.unitPriceCents ?? 0) / 100, p.currency || "USD")}${p.active === false ? ", archived" : ""}`
      );
      return { resultText: `Products (${products.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "create_product",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Add a product to the catalog",
    description: "Add a product (name and unitPriceCents required).",
    parameters: { type: "object", properties: PRODUCT_PROPS, required: ["name", "unitPriceCents"], additionalProperties: false },
    validate: (raw) => {
      const p = productFields(raw);
      if (!p.ok) return p;
      if (!p.fields.name) return { ok: false, error: "a name is required" };
      if (p.fields.unitPriceCents === undefined) return { ok: false, error: "unitPriceCents is required" };
      return { ok: true, args: p.fields as Record<string, unknown> };
    },
    summarize: (args) => `Add the product “${args.name}”.`,
    execute: async (ctx, args) => {
      const id = await createProduct({
        subAccountId: ctx.subAccountId!,
        createdByUid: ctx.uid,
        sanitized: args as Partial<Product>,
        actor: agentActor(ctx, "create_product"),
      });
      if (!id) throw new CapabilityUserError("This workspace wasn't found.");
      return { resultText: `Added the product (id: ${id}).`, ref: { kind: "product", id } };
    },
  },
  {
    name: "update_product",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Edit a product",
    description: "Edit a product's name, description, price, currency, active flag or order-bump settings.",
    parameters: { type: "object", properties: { productId: productIdParam, ...PRODUCT_PROPS }, required: ["productId"], additionalProperties: false },
    validate: (raw) => {
      const productId = str(raw, "productId");
      if (!isDocId(productId)) return { ok: false, error: "a productId is required" };
      const p = productFields(raw);
      if (!p.ok) return p;
      if (!Object.keys(p.fields).length) return { ok: false, error: "give at least one field to change" };
      return { ok: true, args: { productId, ...p.fields } };
    },
    summarize: (args) => `Edit the product ${args.productId}.`,
    // What buyers pay: a price, currency or active change to a product a
    // checkout page or funnel sells needs a person (spend: it moves money).
    approvalFor: async (args, ctx) => {
      const p = await tenantProduct(ctx.subAccountId!, args.productId);
      return touchesMoney(args) && (await productSellers(ctx.subAccountId!, p.id)).length ? "spend" : undefined;
    },
    approvalHint: { approval: "spend", when: "it changes the price, currency or active flag of a product a checkout page or funnel sells" },
    approvalTarget: async (ctx, args) => {
      await tenantProduct(ctx.subAccountId!, args.productId);
      return { contactId: null, territoryId: null, scoped: false };
    },
    preview: async (ctx, args) => {
      const p = await tenantProduct(ctx.subAccountId!, args.productId);
      const sellers = await productSellers(ctx.subAccountId!, p.id);
      const next = { ...p, ...(args as Partial<Product>) };
      const price = (x: Product) => fmtMoney((x.unitPriceCents ?? 0) / 100, x.currency || "USD");
      const changed = (k: keyof Product) => args[k] !== undefined && args[k] !== p[k];
      return {
        rows: [
          { label: "Product", value: `${oneLine(p.name) || "(unnamed)"} (${p.id})` },
          ...recordProvenanceRows(p.id, p),
          { label: "Price", value: changed("unitPriceCents") || changed("currency") ? `${price(p)} → ${price(next)}` : `${price(p)} (unchanged)` },
          { label: "Active", value: changed("active") ? `${p.active !== false} → ${next.active !== false}` : `${p.active !== false} (unchanged)` },
          ...(changed("name") ? [{ label: "Name", value: `${oneLine(p.name)} → ${oneLine(next.name)}` }] : []),
          ...(changed("description") ? [{ label: "Description", value: `${oneLine(p.description)} → ${oneLine(next.description)}` }] : []),
          { label: "Sold by", value: sellers.map((x) => `${x.kind} ${oneLine(x.name) || "(unnamed)"} (${x.id})`).join(", ") || "nothing" },
          { label: "Then", value: "Buyers of those pay the new price, in the new currency; an inactive product can't be bought." },
        ],
        pinned: { productId: p.id, before: moneyOf(p) },
      };
    },
    execute: async (ctx, args) => {
      const { productId, ...fields } = args;
      const p = await tenantProduct(ctx.subAccountId!, productId);
      const db = getAdminDb();
      const ref = db.doc(`products/${p.id}`);
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        if (!current || current.subAccountId !== ctx.subAccountId) throw new CapabilityUserError("That product isn't in this workspace.");
        if (touchesMoney(fields)) {
          if (ctx.approved) {
            if (JSON.stringify(moneyOf(current)) !== JSON.stringify(ctx.approved.pinned?.before)) {
              throw new CapabilityUserError("The product's price or status changed since this was reviewed; nothing was changed.");
            }
          } else if ((await productSellers(ctx.subAccountId!, p.id, (q) => tx.get(q))).length) {
            throw new CapabilityUserError("A checkout page or funnel now sells this product, so this change needs approval: send it again.");
          }
        }
        tx.update(ref, { ...fields, updatedAt: FieldValue.serverTimestamp(), ...agentEditStamp(agentActor(ctx, "update_product")) });
      });
      return { resultText: "Updated the product.", ref: { kind: "product", id: p.id } };
    },
  },
  {
    name: "delete_product",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    approval: "hard_delete",
    menuLabel: "Delete a product (a person approves)",
    description:
      "Delete a product permanently. Refused while a checkout page or funnel sells it (archive it with update_product active:false instead). Open quotes keep their own copy. Queued for a sub-account admin to approve.",
    parameters: { type: "object", properties: { productId: productIdParam }, required: ["productId"], additionalProperties: false },
    validate: (raw) => {
      const productId = str(raw, "productId");
      return isDocId(productId) ? { ok: true, args: { productId } } : { ok: false, error: "a productId is required" };
    },
    summarize: () => "Delete a product.",
    approvalTarget: async (ctx, args) => {
      await tenantProduct(ctx.subAccountId!, args.productId);
      return { contactId: null, territoryId: null, scoped: false };
    },
    preview: async (ctx, args) => {
      const p = await tenantProduct(ctx.subAccountId!, args.productId);
      const used = await productUsage(ctx.subAccountId!, p.id);
      if (used.checkoutPages || used.funnels) {
        throw new CapabilityUserError(
          `That product is sold by ${used.checkoutPages} checkout page(s) and ${used.funnels} funnel(s); deleting it would break them. Archive it instead (update_product active:false).`
        );
      }
      return [
        { label: "Delete product", value: oneLine(p.name) || "(unnamed)" },
        ...recordProvenanceRows(p.id, p),
        { label: "Price", value: `${fmtMoney((p.unitPriceCents ?? 0) / 100, p.currency || "USD")}${p.active === false ? " (archived)" : ""}` },
        { label: "Open quotes / invoices using it", value: `${used.openQuotes} (they keep their own copy of name and price)` },
      ];
    },
    execute: async (ctx, args) => {
      const p = await tenantProduct(ctx.subAccountId!, args.productId);
      const used = await productUsage(ctx.subAccountId!, p.id);
      if (used.checkoutPages || used.funnels) {
        throw new CapabilityUserError("A checkout page or funnel now sells this product; it was not deleted.");
      }
      await getAdminDb().doc(`products/${p.id}`).delete();
      return { resultText: "Deleted the product.", ref: { kind: "product", id: p.id } };
    },
  },
];
