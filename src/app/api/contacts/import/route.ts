import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { createContactServerSide } from "@/lib/server/contacts-service";
import { normalizePhoneLenient } from "@/lib/contacts/phone";
import {
  CONTACT_IDENTITY_ERROR,
  hasContactIdentity,
} from "@/lib/contacts/display-name";

/**
 * Dashboard-facing CSV import. The client parses + maps + validates the CSV
 * locally, then POSTs the valid rows here in chunks (the caller bounds each
 * request to MAX_ROWS so a big import can't time out). Each created contact
 * fires its own `contact.created` — same as a manual add — per the "one
 * event per row" import policy.
 *
 * Dedup: a row matching an existing contact in the sub-account by normalised
 * email or phone (or matching an earlier row in the same request) is
 * SKIPPED, never overwritten — re-importing the same CSV must not duplicate
 * or silently clobber edits made in the dashboard since. Phone comparisons
 * are exact because every write path stores phone through the same
 * `normalizePhoneLenient`. Email is lower-cased before both the lookup and
 * the write here, so contacts created via this route always match on
 * re-import; a contact whose email was stored with different casing by
 * another entry point (the dashboard dialog, the public API) still won't
 * be found by an exact-match query until it's touched again — no other
 * write path normalizes email case today.
 */

const MAX_ROWS = 500;
const FIRESTORE_IN_LIMIT = 30;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Normalised values (lower-cased email / normalized phone) already present
 * on a contact in `subAccountId`, drawn from `rawValues` (the literal,
 * trimmed values this request would otherwise write). Batches lookups in
 * chunks of Firestore's 30-item `in` limit.
 */
async function fetchExistingNormalized(
  db: FirebaseFirestore.Firestore,
  subAccountId: string,
  field: "email" | "phone",
  rawValues: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (rawValues.length === 0) return found;
  const queryValues = new Set(rawValues);
  if (field === "email") {
    for (const v of rawValues) queryValues.add(v.toLowerCase());
  }
  for (const c of chunk([...queryValues], FIRESTORE_IN_LIMIT)) {
    const snap = await db
      .collection("contacts")
      .where("subAccountId", "==", subAccountId)
      .where(field, "in", c)
      .get();
    for (const doc of snap.docs) {
      const val = doc.data()[field];
      if (typeof val === "string" && val) {
        found.add(field === "email" ? val.toLowerCase() : val);
      }
    }
  }
  return found;
}

function str(v: unknown, max = 500): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 50);
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const subAccountId = str(body.subAccountId, 200);
  if (!subAccountId) {
    return NextResponse.json({ error: "subAccountId is required" }, { status: 400 });
  }

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const rows = Array.isArray(body.contacts)
    ? (body.contacts as Record<string, unknown>[])
    : [];
  if (rows.length === 0) {
    return NextResponse.json({ created: 0, skipped: 0, errors: [] });
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `Send at most ${MAX_ROWS} rows per request.` },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const agencyId = (subSnap.data()?.agencyId as string) ?? access.agencyId ?? "";
  const phoneCountry = (subSnap.data()?.defaultPhoneCountry as string) ?? null;

  // Pass 1: validate + normalize every row up front so the dedup lookups can
  // be batched (rather than one Firestore query per row).
  const parsed = rows.map((row) => {
    const name = str(row.name, 200);
    const email = str(row.email);
    const phone = str(row.phone);
    return {
      name,
      email,
      phone,
      normEmail: email.toLowerCase(),
      normPhone: phone ? normalizePhoneLenient(phone, phoneCountry) : "",
      valid: hasContactIdentity({ name, email, phone }),
      company: str(row.company),
      address: str(row.address),
      source: str(row.source),
      tags: strArray(row.tags),
      territoryId: typeof row.territoryId === "string" ? row.territoryId : null,
    };
  });

  const [existingEmails, existingPhones] = await Promise.all([
    fetchExistingNormalized(
      db,
      subAccountId,
      "email",
      [...new Set(parsed.filter((r) => r.valid && r.email).map((r) => r.email))],
    ),
    fetchExistingNormalized(
      db,
      subAccountId,
      "phone",
      [...new Set(parsed.filter((r) => r.valid && r.normPhone).map((r) => r.normPhone))],
    ),
  ]);

  let created = 0;
  let skipped = 0;
  const errors: { index: number; message: string; duplicate?: true }[] = [];
  // Duplicates within THIS request (same CSV listing the same person twice).
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();

  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    if (!row.valid) {
      errors.push({ index: i, message: CONTACT_IDENTITY_ERROR });
      continue;
    }

    const isDuplicate =
      (!!row.normEmail &&
        (existingEmails.has(row.normEmail) || seenEmails.has(row.normEmail))) ||
      (!!row.normPhone &&
        (existingPhones.has(row.normPhone) || seenPhones.has(row.normPhone)));
    if (isDuplicate) {
      skipped++;
      // `duplicate: true` lets the caller tell "already exists, nothing to
      // fix" apart from a genuine per-row failure — see import-contacts-dialog.
      errors.push({ index: i, message: "Skipped — duplicate contact", duplicate: true });
      continue;
    }

    try {
      await createContactServerSide({
        subAccountId,
        agencyId,
        createdByUid: access.uid,
        mode: "live",
        name: row.name,
        // Stored lower-cased so a re-import (or any future import) can match
        // it by exact query — see the dedup note above.
        email: row.normEmail,
        phone: row.phone,
        phoneCountry,
        company: row.company,
        address: row.address,
        source: row.source,
        tags: row.tags,
        territoryId: row.territoryId,
      });
      created++;
      if (row.normEmail) seenEmails.add(row.normEmail);
      if (row.normPhone) seenPhones.add(row.normPhone);
    } catch (err) {
      errors.push({
        index: i,
        message: err instanceof Error ? err.message : "Failed to save",
      });
    }
  }

  return NextResponse.json({ created, skipped, errors });
}
