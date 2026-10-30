import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  requireAgencyOwnerAny,
  requireSubAccountAdmin,
} from "@/lib/auth/require-tenancy";
import {
  deleteSubAccountForAgency,
  SubAccountNotEmptyError,
  SubAccountNotFoundError,
} from "@/lib/server/sub-accounts-service";
import { isSupportedCountry } from "libphonenumber-js";
import type { SendWindow, AccountContact } from "@/types";

interface PatchBody {
  name?: string;
  timezone?: string;
  sendWindow?: SendWindow | null;
  bookingLink?: string | null;
  replyToEmail?: string | null;
  defaultPhoneCountry?: string | null;
  automationsPaused?: boolean;
  emailTracking?: { opens?: unknown; clicks?: unknown } | null;
  accountContact?: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
}

const URL_RE = /^https?:\/\/.+/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidHour(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 24;
}

function isValidSendWindow(v: unknown): v is SendWindow {
  if (!v || typeof v !== "object") return false;
  const w = v as Partial<SendWindow>;
  return (
    isValidHour(w.startHour) &&
    isValidHour(w.endHour) &&
    typeof w.timezone === "string" &&
    w.timezone.length > 0 &&
    (w.startHour as number) < (w.endHour as number)
  );
}

/**
 * Patch a sub-account doc. Allowed fields: name, timezone, sendWindow.
 * Caller must be an active sub-account admin (agency owners pass via the
 * implicit shortcut in requireSubAccountAdmin).
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json(
        { error: "Name cannot be empty." },
        { status: 400 },
      );
    }
    update.name = name;
  }

  if (body.timezone !== undefined) {
    const tz = body.timezone.trim();
    if (!tz) {
      return NextResponse.json(
        { error: "Timezone cannot be empty." },
        { status: 400 },
      );
    }
    update.timezone = tz;
  }

  if (body.sendWindow !== undefined) {
    if (body.sendWindow === null) {
      update.sendWindow = null;
    } else if (!isValidSendWindow(body.sendWindow)) {
      return NextResponse.json(
        {
          error:
            "Send window needs integer startHour < endHour (0-24) and a non-empty timezone.",
        },
        { status: 400 },
      );
    } else {
      update.sendWindow = body.sendWindow;
    }
  }

  if (body.bookingLink !== undefined) {
    if (body.bookingLink === null || body.bookingLink === "") {
      update.bookingLink = null;
    } else if (typeof body.bookingLink !== "string") {
      return NextResponse.json(
        { error: "Booking link must be a string URL or null." },
        { status: 400 },
      );
    } else {
      const trimmed = body.bookingLink.trim();
      if (!URL_RE.test(trimmed)) {
        return NextResponse.json(
          { error: "Booking link must start with http:// or https://." },
          { status: 400 },
        );
      }
      update.bookingLink = trimmed;
    }
  }

  if (body.replyToEmail !== undefined) {
    if (body.replyToEmail === null || body.replyToEmail === "") {
      update.replyToEmail = null;
    } else if (typeof body.replyToEmail !== "string") {
      return NextResponse.json(
        { error: "Reply-to email must be a string or null." },
        { status: 400 },
      );
    } else {
      const trimmed = body.replyToEmail.trim().toLowerCase();
      if (!EMAIL_RE.test(trimmed)) {
        return NextResponse.json(
          { error: "Reply-to email must be a valid email address." },
          { status: 400 },
        );
      }
      update.replyToEmail = trimmed;
    }
  }

  if (body.defaultPhoneCountry !== undefined) {
    // Fallback country for phone numbers typed without a country code
    // (lib/contacts/phone.ts). null/"" clears it back to the US default —
    // existing workspaces that never touch this setting are unaffected.
    if (body.defaultPhoneCountry === null || body.defaultPhoneCountry === "") {
      update.defaultPhoneCountry = null;
    } else if (typeof body.defaultPhoneCountry !== "string") {
      return NextResponse.json(
        { error: "Phone country must be a two-letter country code or null." },
        { status: 400 },
      );
    } else {
      const code = body.defaultPhoneCountry.trim().toUpperCase();
      if (!isSupportedCountry(code)) {
        return NextResponse.json(
          {
            error:
              "Phone country must be a valid two-letter ISO country code (e.g. US, GB, AU).",
          },
          { status: 400 },
        );
      }
      update.defaultPhoneCountry = code;
    }
  }

  if (body.automationsPaused !== undefined) {
    if (typeof body.automationsPaused !== "boolean") {
      return NextResponse.json(
        { error: "automationsPaused must be a boolean." },
        { status: 400 },
      );
    }
    update.automationsPaused = body.automationsPaused;
  }

  if (body.emailTracking !== undefined) {
    // Dot paths: switching one kind never resets the other.
    const t = body.emailTracking;
    if (!t || typeof t !== "object") {
      return NextResponse.json(
        { error: "emailTracking must be an object of booleans." },
        { status: 400 },
      );
    }
    for (const kind of ["opens", "clicks"] as const) {
      if (t[kind] === undefined) continue;
      if (typeof t[kind] !== "boolean") {
        return NextResponse.json(
          { error: `emailTracking.${kind} must be a boolean.` },
          { status: 400 },
        );
      }
      update[`emailTracking.${kind}`] = t[kind];
    }
  }

  if (body.accountContact !== undefined) {
    if (body.accountContact === null) {
      update.accountContact = null;
    } else if (typeof body.accountContact !== "object") {
      return NextResponse.json(
        { error: "accountContact must be an object or null." },
        { status: 400 },
      );
    } else {
      const raw = body.accountContact;
      const name = typeof raw.name === "string" ? raw.name.trim() : "";
      const email =
        typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
      const phone = typeof raw.phone === "string" ? raw.phone.trim() : "";
      if (email && !EMAIL_RE.test(email)) {
        return NextResponse.json(
          { error: "Account contact email must be a valid email address." },
          { status: 400 },
        );
      }
      const normalized: AccountContact | null =
        !name && !email && !phone
          ? null
          : {
              name: name || null,
              email: email || null,
              phone: phone || null,
            };
      update.accountContact = normalized;
    }
  }

  if (Object.keys(update).length === 1) {
    return NextResponse.json(
      { error: "No fields to update." },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  await db.doc(`subAccounts/${subAccountId}`).update(update);

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/agency/sub-accounts/[id]
 * Agency-owner-only. Permanently deletes a **clean** (unused) sub-account and
 * all its structural data (members, seeded templates, counters, usage). Refuses
 * with 409 + the blocking data types if the sub-account holds real CRM data, so
 * a used workspace can never be wiped here.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const owner = await requireAgencyOwnerAny(request);
  if (owner instanceof NextResponse) return owner;

  const { id: subAccountId } = await ctx.params;

  try {
    await deleteSubAccountForAgency({
      agencyId: owner.agencyId as string,
      subAccountId,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof SubAccountNotEmptyError) {
      return NextResponse.json(
        {
          error:
            "This sub-account still has data, so it can't be deleted. It has " +
            `${err.blockers.join(", ")}. Remove those first, or keep it.`,
          blockers: err.blockers,
        },
        { status: 409 },
      );
    }
    if (err instanceof SubAccountNotFoundError) {
      return NextResponse.json(
        { error: "Sub-account not found." },
        { status: 404 },
      );
    }
    console.error("[agency/sub-accounts DELETE] failed", err);
    return NextResponse.json(
      { error: "Failed to delete the sub-account." },
      { status: 500 },
    );
  }
}
