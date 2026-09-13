/**
 * GHL HTTP client for the Velocity WhatsApp GHL backfill (V1,
 * docs/parity/sp2.md): token resolution + the two read-only endpoints this
 * script needs. Split out of `ghl-wa-backfill-io.ts` (which stayed
 * Firestore-side: contact resolution, watchdog check, dry run, write) to
 * keep both files under ~300 lines.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dedupeById, type GhlExportMessage } from "./ghl-wa-backfill-lib.ts";
import { classifyContactLookupStatus } from "./ghl-wa-backfill-guards.ts";

export const GHL_API_BASE = "https://services.leadconnectorhq.com";
export const GHL_API_VERSION = "2021-07-28";
/** Cloudflare in front of leadconnectorhq.com blocks some default UAs outright (see ApexSignal client.ts). */
const USER_AGENT = "curl/8.5.0";

export const VELOCITY_LOCATION_ID = "RcmH5ytbrwH5AXDF2xxr";

// Overlap both edges of the known hole a little; dedupe handles the overlap.
export const WINDOW_START = "2026-09-10T07:10:00.000Z";
export const WINDOW_END = "2026-09-11T12:30:00.000Z";

// ---------------------------------------------------------------------------
// GHL token resolution (mirrors ApexSignal/scripts/ghl-export/tokens.ts).
// ---------------------------------------------------------------------------

async function readTokenFile(filePath: string): Promise<string | null> {
  try {
    const contents = (await readFile(filePath, "utf8")).trim();
    return contents.length > 0 ? contents : null;
  } catch {
    return null;
  }
}

export async function resolveVelocityToken(
  env: Record<string, string | undefined> = process.env,
): Promise<{ token: string; source: string } | null> {
  const envFilePath = env.GHL_TOKEN_FILE_VELOCITY_FIBRE?.trim();
  if (envFilePath) {
    const token = await readTokenFile(envFilePath);
    if (token) return { token, source: `GHL_TOKEN_FILE_VELOCITY_FIBRE -> ${envFilePath}` };
  }
  const tokenDir =
    env.GHL_TOKEN_DIR?.trim() || path.join(env.HOME?.trim() || os.homedir(), ".config", "apexsignal", "ghl-tokens");
  const dirFilePath = path.join(tokenDir, "velocity-fibre");
  const dirToken = await readTokenFile(dirFilePath);
  if (dirToken) return { token: dirToken, source: `GHL_TOKEN_DIR/velocity-fibre (${dirFilePath})` };
  const inline = env.GHL_TOKEN_VELOCITY_FIBRE?.trim();
  if (inline) return { token: inline, source: "env GHL_TOKEN_VELOCITY_FIBRE (inline)" };
  const fileFallback = env.GHL_TOKEN_FILE?.trim();
  if (fileFallback) {
    const token = await readTokenFile(fileFallback);
    if (token) return { token, source: `GHL_TOKEN_FILE -> ${fileFallback}` };
  }
  const sharedInline = env.GHL_TOKEN?.trim() || env.GHL_PIT?.trim();
  if (sharedInline) return { token: sharedInline, source: "env GHL_TOKEN/GHL_PIT (shared fallback)" };
  return null;
}

// ---------------------------------------------------------------------------
// Minimal read-only GHL client for the two endpoints this script needs.
// ---------------------------------------------------------------------------

export class GhlBackfillError extends Error {
  status: number | null;
  constructor(status: number | null, message: string) {
    super(message);
    this.name = "GhlBackfillError";
    this.status = status;
  }
}

async function ghlGet(token: string, pathname: string, query: Record<string, string | number>): Promise<unknown> {
  const url = new URL(pathname, GHL_API_BASE);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      Version: GHL_API_VERSION,
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 500);
    // 401/403 (payment hold, revoked scope) must abort the run, never be read
    // as "this window has zero messages" — a locked-out agency and an empty
    // window look identical from a naive fetch() unless the status is checked.
    throw new GhlBackfillError(
      res.status,
      `GET ${pathname} failed: ${res.status} ${body}` +
        (res.status === 401 || res.status === 403
          ? " (agency may be on the failed-payment hold, or the token lacks scope — see project_velocity_leadstack_wa_gap.md)"
          : ""),
    );
  }
  return res.json();
}

/**
 * Walks `/conversations/messages/export` for Velocity across the hole window,
 * mirroring ApexSignal's `extract-conversations.ts` request shape exactly:
 * `endDate` is sent on EVERY request, `startDate` only when there is no
 * cursor yet (the first request), and once a cursor exists only it (plus
 * `endDate`) is sent. `channel` is omitted deliberately — that returns every
 * non-email message type in one pass, including WhatsApp, and
 * `isWhatsAppMessage` narrows it downstream.
 *
 * A 2xx response with no `messages` array is treated as a hard failure, not
 * an empty page — GHL returning an unexpected envelope shape is exactly the
 * kind of thing a naive `?? []` would silently swallow into "zero messages".
 * A page can be empty AND still carry a cursor (the endpoint's pagination is
 * not guaranteed to fill every page) — the walk only stops when there is no
 * next cursor, never merely because a page returned zero rows.
 */
export async function fetchAllMessages(token: string): Promise<GhlExportMessage[]> {
  const out: GhlExportMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    const query: Record<string, string | number> = {
      locationId: VELOCITY_LOCATION_ID,
      limit: 100,
      sortBy: "createdAt",
      sortOrder: "asc",
      endDate: WINDOW_END,
    };
    if (cursor) query.cursor = cursor;
    else query.startDate = WINDOW_START;

    const body = await ghlGet(token, "/conversations/messages/export", query);
    if (!body || typeof body !== "object" || !Array.isArray((body as Record<string, unknown>).messages)) {
      throw new GhlBackfillError(
        null,
        `GET /conversations/messages/export returned a 2xx with no "messages" array on page ${page} — ` +
          "refusing to treat this as zero messages.",
      );
    }
    const messages = (body as Record<string, unknown>).messages as GhlExportMessage[];
    out.push(...messages);

    const next =
      ((body as Record<string, unknown>).nextCursor as string | undefined) ??
      (((body as Record<string, unknown>).meta as Record<string, unknown> | undefined)?.nextCursor as
        | string
        | undefined);
    if (!next) break; // stop ONLY on no next cursor, not on an empty page
    cursor = next;
    if (page > 500) throw new Error("Aborting: over 500 pages fetched without exhausting — refusing to loop forever.");
  }
  return dedupeById(out);
}

/** `GET /contacts/{id}` phone lookup for the fallback. Aborts the run on anything but a 404. */
export async function fetchGhlContactPhone(token: string, ghlContactId: string): Promise<string | null> {
  let body: unknown;
  try {
    body = await ghlGet(token, `/contacts/${ghlContactId}`, {});
  } catch (err) {
    const status = err instanceof GhlBackfillError ? err.status : null;
    if (classifyContactLookupStatus(status) === "not_found") return null;
    throw err;
  }
  const phone = (body as { contact?: { phone?: unknown } } | undefined)?.contact?.phone;
  return typeof phone === "string" && phone.trim().length > 0 ? phone : null;
}
