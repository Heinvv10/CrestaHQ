import "server-only";

import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { createSubAccountForAgency } from "@/lib/server/sub-accounts-service";
import type { MemberStatus, Role } from "@/types";

interface CreateBody {
  name?: string;
  slug?: string;
  timezone?: string;
  accountContact?: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
}

const SLUG_RE = /^[a-z0-9-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STARTING_ACCOUNT_NUMBER = 1000;

type ContactValidation =
  | { ok: true; value: { name: string | null; email: string | null; phone: string | null } | null }
  | { ok: false; error: string };

function normalizeAccountContact(
  raw: CreateBody["accountContact"],
): ContactValidation {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object") {
    return { ok: false, error: "accountContact must be an object or null." };
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const email =
    typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  const phone = typeof raw.phone === "string" ? raw.phone.trim() : "";
  if (email && !EMAIL_RE.test(email)) {
    return { ok: false, error: "Account contact email must be a valid email address." };
  }
  if (!name && !email && !phone) return { ok: true, value: null };
  return {
    ok: true,
    value: {
      name: name || null,
      email: email || null,
      phone: phone || null,
    },
  };
}

interface CallerClaims {
  role?: Role;
  status?: MemberStatus;
  agencyRole?: "owner" | "staff" | null;
  agencyId?: string | null;
}

async function requireAgencyOwnerFromHeaders(request: Request): Promise<
  | { uid: string; email: string; displayName: string; agencyId: string }
  | NextResponse
> {
  const uid = request.headers.get("x-user-uid");
  if (!uid) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const auth = getAdminAuth();
  const record = await auth.getUser(uid).catch(() => null);
  if (!record) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const claims = (record.customClaims ?? {}) as CallerClaims;
  if (claims.status !== "active") {
    return NextResponse.json({ error: "Account inactive" }, { status: 403 });
  }
  if (claims.agencyRole !== "owner" || !claims.agencyId) {
    return NextResponse.json(
      { error: "Only the agency owner can manage sub-accounts." },
      { status: 403 },
    );
  }
  return {
    uid,
    email: record.email ?? "",
    displayName: record.displayName ?? "",
    agencyId: claims.agencyId,
  };
}

/**
 * Preview the account number that the next sub-account in this agency will
 * receive. Reads the per-agency counter (or falls back to 1000 if it
 * doesn't exist yet — covers older bootstraps that pre-date the numbering
 * migration). UI surfaces this as a read-only field on the create form.
 */
export async function GET(request: Request) {
  const access = await requireAgencyOwnerFromHeaders(request);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const counterSnap = await db
    .doc(`agencies/${access.agencyId}/counters/subAccount`)
    .get();
  const next = counterSnap.exists
    ? (counterSnap.data()?.next as number | undefined) ?? STARTING_ACCOUNT_NUMBER
    : STARTING_ACCOUNT_NUMBER;
  return NextResponse.json({ next });
}

export async function POST(request: Request) {
  const access = await requireAgencyOwnerFromHeaders(request);
  if (access instanceof NextResponse) return access;

  let body: CreateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "Name is required." }, { status: 400 });
  }
  const slug = body.slug?.trim().toLowerCase() || "";
  if (slug && !SLUG_RE.test(slug)) {
    return NextResponse.json(
      { error: "Slug must contain only lowercase letters, numbers, and dashes." },
      { status: 400 },
    );
  }
  const timezone = body.timezone?.trim() || "UTC";
  const contactCheck = normalizeAccountContact(body.accountContact);
  if (!contactCheck.ok) {
    return NextResponse.json({ error: contactCheck.error }, { status: 400 });
  }
  const accountContact = contactCheck.value;
  const { agencyId, uid } = access;

  const { subAccountId, accountNumber } = await createSubAccountForAgency({
    agencyId,
    uid,
    email: access.email,
    displayName: access.displayName,
    name,
    slug,
    timezone,
    accountContact,
  });

  return NextResponse.json({
    subAccountId,
    accountNumber,
    name,
    agencyId,
  });
}
