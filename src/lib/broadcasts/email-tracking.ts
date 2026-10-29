import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { normalizeDestinationUrl } from "@/lib/tracked-links/destination";
import { rewriteAnchorHrefs } from "./email-tracking-html";
import { isTrackingSafeId, issueClickToken, issueOpenToken } from "./tracking-token";
import type { SubAccountDoc } from "@/types";

/**
 * Our own open pixel and click redirect for broadcast emails (W4 PR2), so
 * engagement works on per-sub-account SMTP, which reports none.
 *
 * Both are off unless the sub-account switched them on
 * (`emailTracking.opens` / `.clicks`). With both off — or no app URL, or ids
 * a token can't carry — the HTML comes back untouched, byte for byte.
 *
 * Clicks: each http(s) `<a href>` becomes `/t/c/{token}`, and its
 * destination is stored at `broadcasts/{id}/links/{linkKey}` BEFORE the
 * send. The redirect reads only that doc. `linkKey` is a hash of the URL, so
 * a link whose merge tags differ per recipient gets its own doc and two
 * concurrent steps writing the same link write the same thing. The
 * unsubscribe link, mailto:, tel: and any other scheme are never rewritten.
 * The plain-text part is not touched.
 */

/** Distinct links tracked per email; any further links go out untracked. */
export const MAX_TRACKED_LINKS = 50;

/** Hash of the normalised URL; the doc id under `broadcasts/{id}/links`. */
export function linkKeyFor(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

function appBase(): string | null {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  return base || null;
}

/**
 * `/u/<token>` on this deployment (same test as upstream's
 * `isUnsubscribeLink` in lib/comms/email-events.ts): an opt-out is not
 * engagement and must stay a direct link. A client site's own `/u/` page is
 * an ordinary link.
 */
export function isUnsubscribeLink(url: string, base: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.host === new URL(base).host && parsed.pathname.startsWith("/u/");
  } catch {
    return false;
  }
}

export interface InstrumentInput {
  /** The rendered HTML body, exactly as it would be sent untracked. */
  html: string;
  broadcastId: string;
  contactId: string;
  agencyId: string;
  subAccountId: string;
  tracking: SubAccountDoc["emailTracking"];
  /** The recipient's own unsubscribe URL, as merged into the body. */
  unsubscribeLink: string;
}

/**
 * The HTML to send. Link docs are written before this resolves; a write
 * failure throws, so the caller sends nothing rather than links that 404.
 */
export async function instrumentBroadcastHtml(input: InstrumentInput): Promise<string> {
  const opens = input.tracking?.opens === true;
  const clicks = input.tracking?.clicks === true;
  const base = appBase();
  if (
    (!opens && !clicks) ||
    !base ||
    !isTrackingSafeId(input.broadcastId) ||
    !isTrackingSafeId(input.contactId)
  ) {
    return input.html;
  }

  const links = new Map<string, string>();
  let html = input.html;
  if (clicks) {
    html = rewriteAnchorHrefs(html, (href) => {
      const url = normalizeDestinationUrl(href);
      if (!url) return null;
      if (href.trim() === input.unsubscribeLink || isUnsubscribeLink(url, base)) return null;
      const key = linkKeyFor(url);
      if (!links.has(key)) {
        if (links.size >= MAX_TRACKED_LINKS) return null;
        links.set(key, url);
      }
      return `${base}/t/c/${issueClickToken(input.broadcastId, input.contactId, key)}`;
    });
    await storeLinks(input, links);
  }
  if (opens) {
    const src = `${base}/t/o/${issueOpenToken(input.broadcastId, input.contactId)}`;
    html += `<img src="${src}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`;
  }
  return html;
}

/** Create the link docs this email needs that don't exist yet. */
async function storeLinks(input: InstrumentInput, links: Map<string, string>): Promise<void> {
  if (links.size === 0) return;
  const db = getAdminDb();
  const col = db.collection("broadcasts").doc(input.broadcastId).collection("links");
  const entries = [...links];
  const snaps = await db.getAll(...entries.map(([key]) => col.doc(key)));
  await Promise.all(
    entries.map(async ([key, url], i) => {
      if (snaps[i]!.exists) return;
      try {
        await col.doc(key).create({
          url,
          agencyId: input.agencyId,
          subAccountId: input.subAccountId,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (err) {
        // Another recipient's step created it first; its url is the same.
        if ((err as { code?: number }).code !== 6) throw err;
      }
    }),
  );
}
