import "server-only";

import type { Timestamp } from "firebase-admin/firestore";

import { normalizeDestinationUrl } from "@/lib/tracked-links/destination";
import { isTokenSafeId } from "@/lib/tracked-links/token";
import { isDocId } from "@/lib/server/doc-id";

/** Public-API wire shape for TrackedLink. Frozen contract. */

export interface LinkApiObject {
  id: string;
  object: "link";
  livemode: boolean;
  name: string;
  destination_url: string;
  click_count: number;
  last_clicked_at: string | null;
  created_at: string;
  updated_at: string;
}

function tsToIso(v: unknown): string {
  if (!v) return new Date(0).toISOString();
  if (v instanceof Date) return v.toISOString();
  const m = v as Partial<Timestamp>;
  if (typeof m.toDate === "function") return m.toDate().toISOString();
  if (typeof m.seconds === "number") return new Date(m.seconds * 1000).toISOString();
  return new Date(0).toISOString();
}
function tsToIsoOrNull(v: unknown): string | null {
  if (!v) return null;
  return tsToIso(v);
}

export function serializeLinkForApi(
  id: string,
  data: FirebaseFirestore.DocumentData,
  mode: "live" | "test",
): LinkApiObject {
  return {
    id,
    object: "link",
    livemode: mode === "live",
    name: typeof data.name === "string" ? data.name : "",
    destination_url:
      typeof data.destinationUrl === "string" ? data.destinationUrl : "",
    click_count: typeof data.clickCount === "number" ? data.clickCount : 0,
    last_clicked_at: tsToIsoOrNull(data.lastClickedAt),
    created_at: tsToIso(data.createdAt),
    updated_at: tsToIso(data.updatedAt),
  };
}

export interface ParseResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  /** "invalid_id" when a body id isn't usable as one (the route's error code). */
  code?: "invalid_id";
}

export interface LinkCreateInput {
  name: string;
  destinationUrl: string;
}

export function parseLinkCreate(raw: unknown): ParseResult<LinkCreateInput> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Body must be a JSON object." };
  }
  const b = raw as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 200) {
    return { ok: false, error: "`name` is required (string ≤ 200 chars)." };
  }
  const destinationUrl = normalizeDestinationUrl(b.destination_url);
  if (!destinationUrl) {
    return {
      ok: false,
      error: "`destination_url` must be an absolute http(s) URL.",
    };
  }
  return { ok: true, value: { name, destinationUrl } };
}

export interface LinkRecipientCreateInput {
  contactId: string;
  /** Null = fall back to the link's own destination. */
  destinationUrl: string | null;
}

export function parseLinkRecipientCreate(
  raw: unknown,
): ParseResult<LinkRecipientCreateInput> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Body must be a JSON object." };
  }
  const b = raw as Record<string, unknown>;
  const contactId = typeof b.contact_id === "string" ? b.contact_id.trim() : "";
  if (!contactId) return { ok: false, error: "`contact_id` is required." };
  // A doc id AND token-safe: the token packs `linkId.contactId`, and "__x__"
  // is token-safe but a reserved doc id.
  if (!isTokenSafeId(contactId) || !isDocId(contactId)) {
    return { ok: false, code: "invalid_id", error: "`contact_id` is not a valid id." };
  }
  if (b.destination_url === undefined || b.destination_url === null) {
    return { ok: true, value: { contactId, destinationUrl: null } };
  }
  const destinationUrl = normalizeDestinationUrl(b.destination_url);
  if (!destinationUrl) {
    return {
      ok: false,
      error: "`destination_url` must be an absolute http(s) URL.",
    };
  }
  return { ok: true, value: { contactId, destinationUrl } };
}
