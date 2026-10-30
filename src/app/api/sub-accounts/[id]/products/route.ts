import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  sanitizeProductPayload,
  type CreateProductPayload,
} from "@/lib/products/sanitize";
import { createProduct } from "@/lib/products/write";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import {
  SellOnlineError,
  prepareSellOnlineUpdate,
} from "@/lib/server/products-sell-online-service";
import type { Product } from "@/types/products";
import type { SubAccountDoc } from "@/types/tenancy";

export const dynamic = "force-dynamic";

/**
 * POST /api/sub-accounts/[id]/products
 *
 * Create a new product in the sub-account catalog. Any active member can
 * create products (admin gate not required — a collaborator drafting an
 * invoice might need to add a missing product on the fly).
 *
 * Body shape (all optional except name + unitPriceCents):
 *   {
 *     name: string,
 *     description?: string,
 *     unitPriceCents: number,
 *     currency?: string,
 *     active?: boolean,
 *     ...sell-online fields (sellOnline, slug, publicDescription, delivery),
 *   }
 *
 * Returns: `{ id }` on success.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: subAccountId } = await params;
  if (!isDocId(subAccountId)) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: CreateProductPayload & Record<string, unknown>;
  try {
    body = (await request.json()) as CreateProductPayload &
      Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sanitized = sanitizeProductPayload(body);
  if (!sanitized.name) {
    return NextResponse.json(
      { error: "name is required" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  let sell: Partial<Product>;
  try {
    sell = await prepareSellOnlineUpdate({
      db,
      subAccountId,
      sub: (subSnap.data() ?? {}) as Partial<SubAccountDoc>,
      productId: null,
      existing: null,
      baseUpdates: sanitized,
      body,
    });
  } catch (err) {
    if (err instanceof SellOnlineError) {
      return NextResponse.json(
        { error: err.message, ...(err.code ? { code: err.code } : {}) },
        { status: err.status },
      );
    }
    throw err;
  }

  let id: string | null;
  try {
    id = await createProduct({
      subAccountId,
      agencyId: access.agencyId,
      createdByUid: access.uid,
      sanitized: { ...sanitized, ...sell },
    });
  } catch (err) {
    console.error("[products/create] write failed", err);
    return NextResponse.json(
      { error: "Failed to create product" },
      { status: 500 },
    );
  }
  if (!id) {
    return NextResponse.json(
      { error: "Sub-account is missing an agencyId" },
      { status: 500 },
    );
  }

  return NextResponse.json({ id }, { status: 201 });
}
