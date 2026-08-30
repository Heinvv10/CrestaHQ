import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { createContactServerSide } from "@/lib/server/contacts-service";
import { GET_LEADS_RESULT_LIMIT } from "@/lib/get-leads/business-types";
import type { SubAccountDoc } from "@/types";

/**
 * Get Leads — import selected businesses as contacts.
 *
 * Each imported row becomes an ordinary contact via the shared
 * `createContactServerSide` chokepoint (so `contact.created` webhooks +
 * workflow triggers fire like any other create), with:
 *   - `source: "get-leads"` + a search tag (e.g. "get-leads:plumber-brisbane")
 *   - business name as both contact name and company
 *   - lat/lng from the listing, so pins land on the dashboard Leads map
 *   - a note carrying the enrichment extras (website, socials, rating) that
 *     have no first-class contact field
 *
 * Duplicates are skipped: a row whose normalized phone OR email already
 * exists on a contact in this sub-account is reported back as skipped.
 */

interface ImportRow {
  name?: string;
  category?: string | null;
  fullAddress?: string | null;
  city?: string | null;
  phone?: string | null;
  website?: string | null;
  email?: string | null;
  facebook?: string | null;
  instagram?: string | null;
  rating?: number | null;
  reviewsCount?: number | null;
  latitude?: number | null;
  longitude?: number | null;
}

interface PostBody {
  businesses?: ImportRow[];
  /**
   * Operator-chosen tag for this import batch (the UI pre-fills it from the
   * search, e.g. "plumbers-brisbane", but it's editable). Slugified and
   * stored verbatim alongside the constant "get-leads" tag — no prefix, so
   * it matches exactly what the operator picks in workflow-trigger and
   * broadcast-audience tag filters.
   */
  tag?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanStr(v: unknown, max = 300): string {
  return typeof v === "string" ? v.replace(/[\r\n\t]/g, " ").trim().slice(0, max) : "";
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const sub = subSnap.data() as SubAccountDoc;
  const agencyId = sub.agencyId;

  if (sub.getLeadsEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "Get Leads is locked by your agency." },
      { status: 403 },
    );
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rows = Array.isArray(body.businesses) ? body.businesses : [];
  if (rows.length === 0) {
    return NextResponse.json(
      { error: "Select at least one business to import." },
      { status: 400 },
    );
  }
  if (rows.length > GET_LEADS_RESULT_LIMIT) {
    return NextResponse.json(
      { error: `Import at most ${GET_LEADS_RESULT_LIMIT} businesses at a time.` },
      { status: 400 },
    );
  }

  const tagSlug = cleanStr(body.tag, 60)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const tags = ["get-leads", ...(tagSlug ? [tagSlug] : [])];

  let imported = 0;
  const skipped: { name: string; reason: string }[] = [];
  // Also dedupe within the submitted batch itself (two branches of the same
  // business can share a phone number).
  const seenPhones = new Set<string>();
  const seenEmails = new Set<string>();

  for (const raw of rows) {
    const name = cleanStr(raw.name, 150);
    if (!name) {
      skipped.push({ name: "(unnamed)", reason: "Missing business name" });
      continue;
    }

    const rawPhone = cleanStr(raw.phone, 40);
    const parsed = rawPhone ? parsePhoneNumberFromString(rawPhone) : undefined;
    const phone = parsed?.isValid() ? parsed.number : rawPhone;
    const email = cleanStr(raw.email, 200).toLowerCase();
    const validEmail = EMAIL_RE.test(email) ? email : "";

    if (phone && seenPhones.has(phone)) {
      skipped.push({ name, reason: "Duplicate phone within this import" });
      continue;
    }
    if (validEmail && seenEmails.has(validEmail)) {
      skipped.push({ name, reason: "Duplicate email within this import" });
      continue;
    }

    // Existing-contact dedupe. Equality-only queries — no composite index
    // needed. Batches are ≤40 rows so a couple of lookups per row is fine.
    if (phone) {
      const dupe = await db
        .collection("contacts")
        .where("subAccountId", "==", subAccountId)
        .where("phone", "==", phone)
        .limit(1)
        .get();
      if (!dupe.empty) {
        skipped.push({ name, reason: "A contact with this phone already exists" });
        continue;
      }
    }
    if (validEmail) {
      const dupe = await db
        .collection("contacts")
        .where("subAccountId", "==", subAccountId)
        .where("email", "==", validEmail)
        .limit(1)
        .get();
      if (!dupe.empty) {
        skipped.push({ name, reason: "A contact with this email already exists" });
        continue;
      }
    }

    const lat = typeof raw.latitude === "number" && Number.isFinite(raw.latitude)
      ? raw.latitude
      : null;
    const lng = typeof raw.longitude === "number" && Number.isFinite(raw.longitude)
      ? raw.longitude
      : null;

    const { id: contactId } = await createContactServerSide({
      subAccountId,
      agencyId,
      createdByUid: access.uid,
      mode: "live",
      name,
      email: validEmail,
      phone,
      company: name,
      address: cleanStr(raw.fullAddress, 300),
      source: "get-leads",
      tags,
      location: {
        countryCode: null,
        country: null,
        city: cleanStr(raw.city, 100) || null,
        lat,
        lng,
      },
    });

    // Enrichment extras that have no first-class contact field land in a
    // note so the operator sees them on the profile.
    const extras = [
      raw.category ? `Category: ${cleanStr(raw.category, 100)}` : null,
      raw.website ? `Website: ${cleanStr(raw.website, 300)}` : "Website: none listed",
      raw.rating != null
        ? `Google rating: ${raw.rating}${raw.reviewsCount != null ? ` (${raw.reviewsCount} reviews)` : ""}`
        : null,
      raw.facebook ? `Facebook: ${cleanStr(raw.facebook, 300)}` : null,
      raw.instagram ? `Instagram: ${cleanStr(raw.instagram, 300)}` : null,
    ].filter(Boolean);
    await db
      .collection("contacts")
      .doc(contactId)
      .collection("notes")
      .add({
        content: `Imported from Get Leads.\n${extras.join("\n")}`,
        createdBy: access.uid,
        createdAt: FieldValue.serverTimestamp(),
      });

    if (phone) seenPhones.add(phone);
    if (validEmail) seenEmails.add(validEmail);
    imported++;
  }

  return NextResponse.json({ ok: true, imported, skipped });
}
