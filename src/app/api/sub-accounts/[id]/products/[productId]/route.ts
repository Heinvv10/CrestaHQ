import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { sanitizeProductPayload } from "@/lib/products/sanitize";
import { isDocId } from "@/lib/server/doc-id";
import {
  SELL_KEYS,
  SellOnlineError,
  prepareSellOnlineUpdate,
} from "@/lib/server/products-sell-online-service";
import type { Product } from "@/types/products";
import type { SubAccountDoc } from "@/types/tenancy";

export const dynamic = "force-dynamic";

/**
 * PATCH / DELETE for a single product. Both require the caller to be a
 * member of the product's owning sub-account.
 *
 * PATCH  — partial update of any sanitizable field (name, description,
 *          unitPriceCents, currency, active) and the sell-online fields
 *          (gated, see products-sell-online-service).
 * DELETE — soft delete: flips `active` to false. Historical line items
 *          that snapshotted this product are unaffected. Pass
 *          `?hard=true` for an actual delete (rarely needed; only safe
 *          when no quotes reference the product).
 */

async function loadProductAndAuth(
  request: Request,
  subAccountId: string,
  productId: string,
) {
  if (!isDocId(subAccountId) || !isDocId(productId)) {
    return {
      error: NextResponse.json({ error: "Product not found" }, { status: 404 }),
    };
  }
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return { error: access };

  const db = getAdminDb();
  const snap = await db.doc(`products/${productId}`).get();
  if (!snap.exists) {
    return {
      error: NextResponse.json({ error: "Product not found" }, { status: 404 }),
    };
  }
  const data = snap.data() ?? {};
  if (data.subAccountId !== subAccountId) {
    return {
      error: NextResponse.json(
        { error: "Product belongs to a different sub-account" },
        { status: 403 },
      ),
    };
  }
  return { access, db, ref: snap.ref, product: data as Partial<Product> };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: subAccountId, productId } = await params;
  const loaded = await loadProductAndAuth(request, subAccountId, productId);
  if ("error" in loaded) return loaded.error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const base: Partial<Product> = sanitizeProductPayload(body);
  const subSnap = await loaded.db.doc(`subAccounts/${subAccountId}`).get();
  const sub = (subSnap.data() ?? {}) as Partial<SubAccountDoc>;

  let written: boolean;
  try {
    // Validated against the product as it is at commit time, so a parallel
    // edit (a price set to 0, say) can't slip past the sell-online checks.
    written = await loaded.db.runTransaction(async (tx) => {
      const fresh = (await tx.get(loaded.ref)).data() as Partial<Product> | undefined;
      if (!fresh || fresh.subAccountId !== subAccountId) {
        throw new SellOnlineError("Product not found", 404);
      }
      const sell = await prepareSellOnlineUpdate({
        db: loaded.db,
        subAccountId,
        sub,
        productId,
        existing: fresh,
        baseUpdates: base,
        body,
      });
      const updates = { ...base, ...sell };
      if (Object.keys(updates).length === 0) return false;
      tx.update(loaded.ref, {
        ...updates,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return true;
    });
  } catch (err) {
    if (err instanceof SellOnlineError) {
      return NextResponse.json(
        { error: err.message, ...(err.code ? { code: err.code } : {}) },
        { status: err.status },
      );
    }
    console.error("[products/update] write failed", err);
    return NextResponse.json(
      { error: "Failed to update product" },
      { status: 500 },
    );
  }

  if (!written) {
    // Unchanged sell-online values (e.g. a round-trip with the gate off) are a
    // no-op, not an error.
    if (SELL_KEYS.some((k) => k in body)) return NextResponse.json({ ok: true });
    return NextResponse.json(
      { error: "No valid fields to update" },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: subAccountId, productId } = await params;
  const url = new URL(request.url);
  const hard = url.searchParams.get("hard") === "true";

  const loaded = await loadProductAndAuth(request, subAccountId, productId);
  if ("error" in loaded) return loaded.error;

  try {
    if (hard) {
      // As for the agent's delete_product: a hard delete would break its buy
      // link. Re-read in the delete's own transaction.
      const outcome = await loaded.db.runTransaction(async (tx) => {
        const fresh = (await tx.get(loaded.ref)).data();
        if (!fresh || fresh.subAccountId !== subAccountId) return "not_found";
        if (fresh.sellOnline === true) return "on_sale";
        tx.delete(loaded.ref);
        return "deleted";
      });
      if (outcome === "not_found") {
        return NextResponse.json({ error: "Product not found" }, { status: 404 });
      }
      if (outcome === "on_sale") {
        return NextResponse.json(
          { error: "This product is on sale online. Take it off sale first.", code: "on_sale" },
          { status: 409 },
        );
      }
    } else {
      await loaded.ref.update({
        active: false,
        // Archiving takes it off sale, so resyncs must not skip it.
        ...(loaded.product.sellOnline === true
          ? { publicVersion: (loaded.product.publicVersion ?? 0) + 1 }
          : {}),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  } catch (err) {
    console.error("[products/delete] failed", err);
    return NextResponse.json(
      { error: "Failed to delete product" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
