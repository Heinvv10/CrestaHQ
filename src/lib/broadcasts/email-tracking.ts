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
 * (`emailTracking.opens` / `.clicks`). With both off — or no app URL, ids a
 * token can't carry, or a body over MAX_INSTRUMENTED_HTML_CHARS — the HTML
 * comes back untouched, byte for byte.
 *
 * Clicks: each http(s) `<a href>` becomes `/t/c/{token}`, and its
 * destination is stored at `broadcasts/{id}/links/{linkKey}` BEFORE the
 * send. The redirect reads only that doc. `linkKey` is a hash of the URL, so
 * a link whose merge tags differ per recipient gets one doc per distinct
 * rendered URL (bounded by MAX_LINK_DOCS_PER_BROADCAST). The unsubscribe
 * link, mailto:, tel: and any other scheme are never rewritten. The
 * plain-text part is not touched.
 */

/** Distinct links tracked per email; any further links go out untracked. */
export const MAX_TRACKED_LINKS = 50;
/**
 * Link docs per broadcast. A merge tag in an href makes one doc per distinct
 * rendered URL — per recipient, at worst — so this bounds the writes; links
 * beyond it go out untracked. Counted in `broadcasts/{id}.trackedLinkCount`,
 * inside the transaction that creates the docs.
 */
export const MAX_LINK_DOCS_PER_BROADCAST = 500;
/** Bodies larger than this go out untracked (and logged), unparsed. */
export const MAX_INSTRUMENTED_HTML_CHARS = 500_000;

/** Hash of the normalised URL; the doc id under `broadcasts/{id}/links`. */
export function linkKeyFor(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

function appBase(): string | null {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  return base || null;
}

/** Path as the router would match it: decoded, `//` collapsed, first segment lower-cased. */
function normalisedPath(pathname: string): string {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // A malformed escape stays as written; it can't hide a "/u/" prefix.
  }
  const segments = path.replace(/\/{2,}/g, "/").split("/");
  if (segments[1]) segments[1] = segments[1].toLowerCase();
  return segments.join("/");
}

/**
 * `/u/<token>` on this deployment (upstream's `isUnsubscribeLink` in
 * lib/comms/email-events.ts, with the path normalised so `/U/…`, `//u/…`
 * or `/%75/…` can't slip through): an opt-out is not engagement and must
 * stay a direct link. A client site's own `/u/` page is an ordinary link.
 */
export function isUnsubscribeLink(url: string, base: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.host === new URL(base).host && normalisedPath(parsed.pathname).startsWith("/u/");
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
  if (input.html.length > MAX_INSTRUMENTED_HTML_CHARS) {
    console.warn(
      "[broadcasts/tracking] body over the size cap; sent untracked",
      input.broadcastId,
      input.contactId,
      input.html.length,
    );
    return input.html;
  }

  let html = input.html;
  if (clicks) {
    const trackable = (href: string): string | null => {
      const url = normalizeDestinationUrl(href);
      if (!url) return null;
      if (href.trim() === input.unsubscribeLink || isUnsubscribeLink(url, base)) return null;
      return url;
    };
    // Pass 1 collects the links; pass 2 wraps only those that got a doc.
    const wanted = new Map<string, string>();
    rewriteAnchorHrefs(html, (href) => {
      const url = trackable(href);
      if (url && wanted.size < MAX_TRACKED_LINKS) wanted.set(linkKeyFor(url), url);
      return null;
    });
    const stored = await storeLinks(input, wanted);
    html = rewriteAnchorHrefs(html, (href) => {
      const url = trackable(href);
      const key = url ? linkKeyFor(url) : null;
      if (!key || !stored.has(key)) return null;
      return `${base}/t/c/${issueClickToken(input.broadcastId, input.contactId, key)}`;
    });
  }
  if (opens) {
    const src = `${base}/t/o/${issueOpenToken(input.broadcastId, input.contactId)}`;
    html += `<img src="${src}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`;
  }
  return html;
}

/**
 * Make sure each wanted link has its doc, within the broadcast's cap.
 * Returns the keys that have one. Docs that already exist cost one batched
 * read; new ones are created in a transaction that also moves
 * `trackedLinkCount`, so concurrent steps can't overshoot the cap or race
 * each other's create.
 */
async function storeLinks(input: InstrumentInput, wanted: Map<string, string>): Promise<Set<string>> {
  const stored = new Set<string>();
  if (wanted.size === 0) return stored;
  const db = getAdminDb();
  const broadcastRef = db.collection("broadcasts").doc(input.broadcastId);
  const col = broadcastRef.collection("links");
  const entries = [...wanted];
  const snaps = await db.getAll(...entries.map(([key]) => col.doc(key)));
  const missing = entries.filter((_, i) => {
    if (!snaps[i]!.exists) return true;
    stored.add(entries[i]![0]);
    return false;
  });
  if (missing.length === 0) return stored;

  const created = await db.runTransaction(async (tx) => {
    const added = new Set<string>();
    const [broadcastSnap, ...linkSnaps] = await tx.getAll(
      broadcastRef,
      ...missing.map(([key]) => col.doc(key)),
    );
    const before = (broadcastSnap!.data()?.trackedLinkCount as number | undefined) ?? 0;
    let count = before;
    missing.forEach(([key, url], i) => {
      if (linkSnaps[i]!.exists) {
        added.add(key);
      } else if (count < MAX_LINK_DOCS_PER_BROADCAST) {
        tx.create(col.doc(key), {
          url,
          agencyId: input.agencyId,
          subAccountId: input.subAccountId,
          createdAt: FieldValue.serverTimestamp(),
        });
        count += 1;
        added.add(key);
      }
    });
    if (count !== before) tx.update(broadcastRef, { trackedLinkCount: count });
    return added;
  });
  for (const key of created) stored.add(key);
  return stored;
}
