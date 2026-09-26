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
import { hasUnsafeText, lookAlikeProblem, oneLine, UNSAFE_TEXT_MESSAGE } from "./text-safety";
import { recordProvenanceRows } from "./record-provenance";

/**
 * Catalog products for API agents (AGENT_API_V1_PLAN.md, PR10): list,
 * create / update as direct writes (the products route's own sanitizer and
 * writer) — except any edit of a product a checkout page or funnel sells,
 * which a person approves — and delete
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

const PRODUCT_LABELS: Record<string, string> = {
  name: "Name",
  description: "Description",
  price: "Price",
  active: "Active",
  bumpEligible: "Offered as an order bump",
  bumpHeadline: "Bump headline",
};

/** The stored value of each field the edit touches (null when unset); a
 *  price is its amount and currency together, so either pins both. */
const valuesOf = (p: FirebaseFirestore.DocumentData, fields: Record<string, unknown>) => {
  const keys = new Set(Object.keys(fields));
  if (keys.has("unitPriceCents") || keys.has("currency")) ["unitPriceCents", "currency"].forEach((k) => keys.add(k));
  return Object.fromEntries([...keys].sort().map((k) => [k, p[k] ?? null]));
};

/** The sanitized payload of the args, or an error for hidden text / bad values. */
function productFields(raw: unknown): { ok: true; fields: Partial<Product> } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  for (const k of TEXT_FIELDS) {
    if (r[k] !== undefined && typeof r[k] !== "string") return { ok: false, error: `${k} must be text` };
    if (typeof r[k] === "string" && hasUnsafeText(r[k] as string)) return { ok: false, error: `${k} ${UNSAFE_TEXT_MESSAGE}` };
  }
  const lookAlike = typeof r.name === "string" ? lookAlikeProblem(r.name, []) : null;
  if (lookAlike) return { ok: false, error: `the name ${lookAlike}` };
  if (r.unitPriceCents !== undefined && (typeof r.unitPriceCents !== "number" || !Number.isFinite(r.unitPriceCents) || r.unitPriceCents < 0)) {
    return { ok: false, error: "unitPriceCents must be a whole number of cents, 0 or more" };
  }
  if (r.currency !== undefined && (typeof r.currency !== "string" || !/^[A-Za-z]{3}$/.test(r.currency))) {
    return { ok: false, error: "currency must be a 3-letter code" };
  }
  return { ok: true, fields: sanitizeProductPayload(r) };
}

/** Refuses a name that could pass for another product's in the sub-account.
 *  Two agent writes racing past each other is accepted: the racer is the
 *  agent itself, and each write is stamped as its own. */
async function assertNameDistinct(subAccountId: string, name: string, selfId: string | null): Promise<void> {
  const snap = await getAdminDb().collection("products").where("subAccountId", "==", subAccountId).get();
  const problem = lookAlikeProblem(name.trim(), snap.docs.filter((d) => d.id !== selfId).map((d) => String(d.data().name ?? "")));
  if (problem) throw new CapabilityUserError(`The name ${problem} (another product's).`);
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
      await assertNameDistinct(ctx.subAccountId!, args.name as string, null);
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
    // Checkout pages show a product's name, description, price and bump
    // settings: any change to one a checkout page or funnel sells is what its
    // buyers see and pay, so a person approves it (spend).
    approvalFor: async (args, ctx) => {
      const p = await tenantProduct(ctx.subAccountId!, args.productId);
      return (await productSellers(ctx.subAccountId!, p.id)).length ? "spend" : undefined;
    },
    approvalHint: { approval: "spend", when: "the product is sold by a checkout page or funnel" },
    approvalTarget: async (ctx, args) => {
      await tenantProduct(ctx.subAccountId!, args.productId);
      return { contactId: null, territoryId: null, scoped: false };
    },
    preview: async (ctx, args) => {
      const p = await tenantProduct(ctx.subAccountId!, args.productId);
      const sellers = await productSellers(ctx.subAccountId!, p.id);
      const { productId: _id, ...fields } = args;
      const next = { ...p, ...(fields as Partial<Product>) };
      const shown: Record<string, (x: Product) => string> = {
        name: (x) => oneLine(x.name),
        description: (x) => oneLine(x.description),
        price: (x) => fmtMoney((x.unitPriceCents ?? 0) / 100, x.currency || "USD"),
        active: (x) => String(x.active !== false),
        bumpEligible: (x) => String(x.bumpEligible === true),
        bumpHeadline: (x) => oneLine(x.bumpHeadline),
      };
      const asked = (k: string) => (k === "price" ? fields.unitPriceCents !== undefined || fields.currency !== undefined : fields[k] !== undefined);
      const rows = Object.entries(shown)
        .filter(([k]) => asked(k))
        .map(([k, show]) => {
          const [before, after] = [show(p) || "(none)", show(next) || "(none)"];
          return { label: PRODUCT_LABELS[k], value: before === after ? `${before} (unchanged)` : `${before} → ${after}` };
        });
      return {
        rows: [
          { label: "Product", value: `${oneLine(p.name) || "(unnamed)"} (${p.id})` },
          ...recordProvenanceRows(p.id, p),
          ...rows,
          { label: "Sold by", value: sellers.map((x) => `${x.kind} ${oneLine(x.name) || "(unnamed)"} (${x.id})`).join(", ") || "nothing" },
          { label: "Then", value: "Buyers on those see and pay the new version; an inactive product can't be bought." },
        ],
        pinned: { productId: p.id, before: valuesOf(p, fields) },
      };
    },
    execute: async (ctx, args) => {
      const { productId, ...fields } = args;
      const p = await tenantProduct(ctx.subAccountId!, productId);
      if (typeof fields.name === "string") await assertNameDistinct(ctx.subAccountId!, fields.name, p.id);
      const db = getAdminDb();
      const ref = db.doc(`products/${p.id}`);
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        if (!current || current.subAccountId !== ctx.subAccountId) throw new CapabilityUserError("That product isn't in this workspace.");
        if (ctx.approved) {
          if (JSON.stringify(valuesOf(current, fields)) !== JSON.stringify(ctx.approved.pinned?.before)) {
            throw new CapabilityUserError("The product changed since this was reviewed; nothing was changed.");
          }
        } else if ((await productSellers(ctx.subAccountId!, p.id, (q) => tx.get(q))).length) {
          throw new CapabilityUserError("A checkout page or funnel now sells this product, so this change needs approval: send it again.");
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
      const db = getAdminDb();
      const ref = db.doc(`products/${p.id}`);
      // What sells it is re-read in the delete's own transaction.
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        if (!current || current.subAccountId !== ctx.subAccountId) throw new CapabilityUserError("That product isn't in this workspace.");
        if ((await productSellers(ctx.subAccountId!, p.id, (q) => tx.get(q))).length) {
          throw new CapabilityUserError("A checkout page or funnel now sells this product; it was not deleted.");
        }
        tx.delete(ref);
      });
      return { resultText: "Deleted the product.", ref: { kind: "product", id: p.id } };
    },
  },
];
