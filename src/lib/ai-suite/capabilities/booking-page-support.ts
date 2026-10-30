import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import type { BookingPage, BookingPageFormData } from "@/types/booking";
import { CHECKOUT_THEME_IDS } from "@/types/checkout-pages";
import { GLOBAL_TERRITORY_ID } from "@/types";
import { CapabilityUserError, type PreviewRow, type ValidateResult } from "./types";
import { hasUnsafeText, lookAlikeProblem, oneLine, UNSAFE_TEXT_MESSAGE } from "./text-safety";

/** Shared by the booking-page capabilities (booking-pages.ts, booking-page-edit.ts). */

export const slugParam = { type: "string", description: "The page's slug (from list_booking_pages)." };

/** Every field the booking-page editor saves (BookingPageFormData), in the
 *  shape the booking-page routes validate. */
export const FORM_KEYS = [
  "slug", "name", "description", "status", "durationMinutes", "bufferMinutes", "bufferBeforeMinutes", "slotIntervalMinutes",
  "workingHours", "dateOverrides", "timezone", "visibleDays", "minNoticeHours", "maxPerDay", "intakeFields", "hosts",
  "allowHostSelection", "calendarType", "distribution", "seatsPerSlot", "services", "logoUrl", "accentColor", "themePreset", "meetingUrl",
  "confirmationMessage", "redirectUrl", "redirectAppendParams", "remindersEnabled", "reminderOffsetsMinutes", "payment",
  "defaultTerritoryId",
] as const satisfies ReadonlyArray<keyof BookingPageFormData>;

const any = {};
export const PAGE_PROPS: Record<string, unknown> = {
  ...Object.fromEntries(FORM_KEYS.map((k) => [k, any])),
  slug: { type: "string", description: "The public URL segment: lowercase letters, digits, dashes." },
  name: { type: "string" },
  description: { type: "string" },
  status: { type: "string", enum: ["draft", "published"], description: "published: bookable by the public." },
  timezone: { type: "string", description: "IANA zone. Omitted on create: the sub-account's own timezone." },
  confirmationMessage: { type: "string" },
  themePreset: { enum: [...CHECKOUT_THEME_IDS, null], description: "Style preset of the public page. null: the standard look." },
};

/** The asked fields: every text in them visible (line breaks allowed), and a name that imitates nothing. */
export function pageFields(raw: unknown, keys: readonly string[] = FORM_KEYS): ValidateResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const args = Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));
  const texts: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") texts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(args);
  if (texts.some((t) => hasUnsafeText(t.replace(/\r?\n/g, " ")))) return { ok: false, error: `a text ${UNSAFE_TEXT_MESSAGE}` };
  if (args.defaultTerritoryId !== undefined && args.defaultTerritoryId !== null && !isDocId(args.defaultTerritoryId)) {
    return { ok: false, error: "defaultTerritoryId must be a territory's id or null" };
  }
  if (typeof args.name === "string") {
    const problem = lookAlikeProblem(args.name, []);
    if (problem) return { ok: false, error: `the name ${problem}` };
  }
  return { ok: true, args };
}

export async function tenantPage(subAccountId: string, slug: unknown, get = (ref: FirebaseFirestore.DocumentReference) => ref.get()): Promise<BookingPage> {
  const snap = isDocId(slug) ? await get(getAdminDb().doc(`subAccounts/${subAccountId}/bookingPages/${slug}`)) : null;
  const data = snap?.data();
  if (!data) throw new CapabilityUserError("That booking page isn't in this workspace.");
  return { ...(data as Omit<BookingPage, "id">), id: snap!.id };
}

/** Refuses a default territory that isn't one of this sub-account's. */
export async function assertPageTerritory(subAccountId: string, territoryId: string | null | undefined): Promise<void> {
  if (!territoryId || territoryId === GLOBAL_TERRITORY_ID) return;
  if (!(await getAdminDb().doc(`subAccounts/${subAccountId}/territories/${territoryId}`).get()).exists) {
    throw new CapabilityUserError("That default territory isn't in this workspace.");
  }
}

/** Refuses a name that could pass for another booking page's. */
export async function assertPageName(subAccountId: string, name: string, selfSlug: string | null): Promise<void> {
  const snap = await getAdminDb().collection(`subAccounts/${subAccountId}/bookingPages`).get();
  const problem = lookAlikeProblem(name.trim(), snap.docs.filter((d) => d.id !== selfSlug).map((d) => String(d.data().name ?? "")));
  if (problem) throw new CapabilityUserError(`The name ${problem} (another booking page's).`);
}

/** The editor's fields of a stored page. */
export const formOf = (p: Partial<BookingPage>): Record<string, unknown> =>
  Object.fromEntries(FORM_KEYS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));

const shown = (v: unknown) => (v === undefined || v === null || v === "" ? "(none)" : typeof v === "string" ? oneLine(v) : JSON.stringify(v));

/** The page as an approver reads it: every field, or with `before` only the changed ones, old -> new. */
export function pageRows(after: Record<string, unknown>, before: Record<string, unknown> | null): PreviewRow[] {
  return FORM_KEYS.flatMap((k) => {
    const [a, b] = [before ? shown(before[k]) : null, shown(after[k])];
    if (a === b) return [];
    return [{ label: k, value: a === null ? b : `${a} \u2192 ${b}` }];
  });
}
