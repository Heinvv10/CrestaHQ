import "server-only";

import { randomUUID } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { quoteFingerprint } from "@/lib/quotes/send-preview";
import type { Quote } from "@/types/quotes";

/**
 * A quote being sent is claimed (`sendingClaim`) from before its email is
 * rendered until the send is recorded, so an agent's edit can't change the
 * document between the email and the link it carries (update_quote refuses
 * while a fresh claim stands). A claim older than SEND_CLAIM_TTL_MS is
 * treated as gone: a crashed send never locks the quote.
 */

export const SEND_CLAIM_TTL_MS = 10 * 60 * 1000;

export interface SendClaim {
  id: string;
  /** Epoch ms. */
  at: number;
  /** quoteFingerprint of the document the email is rendered from. */
  fingerprint: string;
}

export function sendClaimFresh(data: FirebaseFirestore.DocumentData | undefined, now = Date.now()): boolean {
  const c = data?.sendingClaim as SendClaim | null | undefined;
  return !!c && typeof c.at === "number" && now - c.at < SEND_CLAIM_TTL_MS;
}

/** Claim the quote as loaded, or why not (another send running, or it changed since it was read). */
export async function claimQuoteForSend(
  ref: FirebaseFirestore.DocumentReference,
  loaded: Quote,
): Promise<{ ok: true; claim: SendClaim } | { ok: false; code: string; error: string }> {
  const claim: SendClaim = { id: randomUUID(), at: Date.now(), fingerprint: quoteFingerprint(loaded) };
  return getAdminDb().runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data() as Quote | undefined;
    if (sendClaimFresh(current)) return { ok: false as const, code: "send_in_progress", error: "This is being sent right now; try again in a minute." };
    if (!current || current.status === "paid" || quoteFingerprint(current) !== claim.fingerprint) {
      return { ok: false as const, code: "changed_while_sending", error: "It changed while it was being sent; nothing was sent." };
    }
    tx.update(ref, { sendingClaim: claim });
    return { ok: true as const, claim };
  });
}

/** Drop our claim after a send that didn't happen (another claim is left alone). */
export async function releaseSendClaim(ref: FirebaseFirestore.DocumentReference, claimId: string): Promise<void> {
  await getAdminDb()
    .runTransaction(async (tx) => {
      if ((await tx.get(ref)).data()?.sendingClaim?.id === claimId) tx.update(ref, { sendingClaim: null });
    })
    .catch((err: unknown) => console.error(`[quotes/send] claim ${claimId} not released (it expires on its own)`, err));
}

/** Step 8 of the send: record it (never over a recorded payment) and drop
 *  our claim, if any. True when a claimed send's document is no longer the
 *  one the email showed, or was paid meanwhile (claims are only taken on an
 *  unpaid quote); then no pay link is written onto it. A quote accepted (or
 *  signed) while the email was out keeps its status and its link: nothing of
 *  the send is recorded over the accept, and the answer is always true. */
export async function recordSendAndRelease(
  ref: FirebaseFirestore.DocumentReference,
  claim: SendClaim | null,
  update: Record<string, unknown>,
  payLink: Record<string, unknown> | null,
): Promise<boolean> {
  let changed = false;
  await getAdminDb().runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data() as Quote | undefined;
    const paid = current?.status === "paid";
    // An invoice converted from a signed quote carries the signature and is
    // sent normally; only a quote's accept is final.
    const accepted = !!current && current.kind !== "invoice" && (!!current.signature || current.status === "accepted");
    changed = accepted || (!!claim && (!current || paid || quoteFingerprint(current) !== claim.fingerprint));
    const releaseClaim = claim && (current as { sendingClaim?: SendClaim | null } | undefined)?.sendingClaim?.id === claim.id;
    if (accepted) {
      if (releaseClaim) tx.update(ref, { sendingClaim: null });
      return;
    }
    tx.update(ref, {
      ...(paid ? {} : { status: "sent" }),
      ...update,
      ...(claim && paid ? {} : (payLink ?? {})),
      ...(releaseClaim ? { sendingClaim: null } : {}),
    });
  });
  return changed;
}
