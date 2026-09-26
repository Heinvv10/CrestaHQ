import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  sanitizeProductPayload,
  type CreateProductPayload,
} from "@/lib/products/sanitize";
import { createProduct } from "@/lib/products/write";

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
 *   }
 *
 * Returns: `{ id }` on success.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: subAccountId } = await params;

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: CreateProductPayload;
  try {
    body = (await request.json()) as CreateProductPayload;
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

  let id: string | null;
  try {
    id = await createProduct({
      subAccountId,
      agencyId: access.agencyId,
      createdByUid: access.uid,
      sanitized,
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
