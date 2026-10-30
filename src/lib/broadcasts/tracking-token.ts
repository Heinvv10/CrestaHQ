import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed tokens for the broadcast open pixel (`/t/o/{token}`) and click
 * redirect (`/t/c/{token}`).
 *
 * Same construction as the tracked-link token (`lib/tracked-links/token.ts`):
 * an HMAC over the payload, appended to it, verified timing-safely.
 *   open:  `broadcastId.contactId.sig`
 *   click: `broadcastId.contactId.linkKey.sig`
 * The HMAC input carries a purpose prefix, so neither token verifies as the
 * other, nor as an `/l/` tracked-link token signed with the same secret.
 *
 * The token only says which recipient opened or clicked; the click
 * destination is never in it — the route reads `broadcasts/{id}/links/{key}`,
 * written at send time.
 */

/** A "." in any id would break the split on verify. */
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
/** What `sign` emits. Checked before the compare: a presented value of the
 *  right string length but with non-ASCII characters has a different BYTE
 *  length, and `timingSafeEqual` throws on unequal buffers. */
const SIG_RE = /^[0-9a-f]{64}$/;

const OPEN_PURPOSE = "broadcast-open";
const CLICK_PURPOSE = "broadcast-click";

/** Whether an id can go into a tracking token; callers skip tracking otherwise. */
export function isTrackingSafeId(id: string): boolean {
  return ID_RE.test(id);
}

function getSecret(): string {
  const s = process.env.AUTOMATIONS_TOKEN_SECRET;
  if (!s) throw new Error("AUTOMATIONS_TOKEN_SECRET is not configured");
  return s;
}

function sign(purpose: string, ids: string[]): string {
  return createHmac("sha256", getSecret())
    .update(`${purpose}:${ids.join(".")}`)
    .digest("hex");
}

function issue(purpose: string, ids: string[]): string {
  if (!ids.every((id) => ID_RE.test(id))) {
    throw new Error("Unexpected id format for broadcast tracking token");
  }
  return `${ids.join(".")}.${sign(purpose, ids)}`;
}

/** The signed ids, or null on any failure — wrong part count, an id with
 *  unexpected characters, a missing secret or a bad signature. */
function verify(purpose: string, token: string, idCount: number): string[] | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== idCount + 1) return null;
  const ids = parts.slice(0, idCount);
  const presentedSig = parts[idCount]!;
  if (!ids.every((id) => ID_RE.test(id)) || !SIG_RE.test(presentedSig)) return null;

  let expectedSig: string;
  try {
    expectedSig = sign(purpose, ids);
  } catch {
    return null;
  }
  if (!timingSafeEqual(Buffer.from(presentedSig), Buffer.from(expectedSig))) {
    return null;
  }
  return ids;
}

export function issueOpenToken(broadcastId: string, contactId: string): string {
  return issue(OPEN_PURPOSE, [broadcastId, contactId]);
}

export function verifyOpenToken(
  token: string,
): { broadcastId: string; contactId: string } | null {
  const ids = verify(OPEN_PURPOSE, token, 2);
  if (!ids) return null;
  const [broadcastId, contactId] = ids as [string, string];
  return { broadcastId, contactId };
}

export function issueClickToken(
  broadcastId: string,
  contactId: string,
  linkKey: string,
): string {
  return issue(CLICK_PURPOSE, [broadcastId, contactId, linkKey]);
}

export function verifyClickToken(
  token: string,
): { broadcastId: string; contactId: string; linkKey: string } | null {
  const ids = verify(CLICK_PURPOSE, token, 3);
  if (!ids) return null;
  const [broadcastId, contactId, linkKey] = ids as [string, string, string];
  return { broadcastId, contactId, linkKey };
}
