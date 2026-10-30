import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Funnel subdomain claims — `funnelSubdomains/{name}` (top-level).
 *
 * Funnel SLUGS are only unique per sub-account, but a subdomain is one flat
 * global namespace across the whole deployment — two sub-accounts cannot both
 * be `offer.leadstack.dev`. So claims live in their own top-level collection,
 * doc id = the subdomain, taken and released inside transactions so two
 * concurrent saves can't both win the same name.
 *
 * Server-only collection (rules: deny all) — the claim IS the authority for
 * host routing, so a client-writable claim would let one tenant hijack
 * another's subdomain.
 */

/** Names that must never become funnels — app surfaces, mail, and the usual
 *  infrastructure prefixes people expect to be "official". */
const RESERVED = new Set([
  "www", "app", "api", "mail", "email", "smtp", "imap", "pop", "ftp",
  "admin", "dashboard", "login", "signup", "auth", "account", "accounts",
  "help", "support", "docs", "blog", "status", "dev", "staging", "test",
  "cdn", "static", "assets", "img", "images", "pay", "billing", "checkout",
  "webhooks", "webhook", "ns1", "ns2", "mx", "autodiscover", "vercel",
]);

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export function subdomainError(name: string): string | null {
  if (!name) return "Enter a subdomain.";
  if (name.length < 3) return "At least 3 characters.";
  if (!NAME_RE.test(name)) {
    return "Lowercase letters, numbers and hyphens only (no leading/trailing hyphen, max 40).";
  }
  if (RESERVED.has(name)) return `"${name}" is reserved.`;
  return null;
}

export function normaliseSubdomain(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export interface SubdomainClaim {
  subAccountId: string;
  agencyId: string;
  funnelId: string;
}

/** Who owns a subdomain, or null. The host-routing resolver's one read. */
export async function resolveSubdomain(
  name: string,
): Promise<SubdomainClaim | null> {
  if (subdomainError(name)) return null;
  const snap = await getAdminDb().doc(`funnelSubdomains/${name}`).get();
  return snap.exists ? (snap.data() as SubdomainClaim) : null;
}

export async function subdomainAvailable(
  name: string,
  forFunnelId?: string,
): Promise<boolean> {
  const claim = await resolveSubdomain(name);
  return !claim || claim.funnelId === forFunnelId;
}

export class SubdomainTakenError extends Error {
  constructor(name: string) {
    super(`"${name}" is already in use by another funnel.`);
    this.name = "SubdomainTakenError";
  }
}

/**
 * Atomically move a funnel from `previous` to `next` (either may be null).
 * Throws SubdomainTakenError when `next` belongs to a different funnel —
 * inside the transaction, so a concurrent claim of the same name can't
 * produce two owners.
 */
export async function reassignSubdomain(input: {
  previous: string | null;
  next: string | null;
  claim: SubdomainClaim;
}): Promise<void> {
  const { previous, next, claim } = input;
  if (previous === next) return;
  const db = getAdminDb();

  await db.runTransaction(async (tx) => {
    if (next) {
      const ref = db.doc(`funnelSubdomains/${next}`);
      const snap = await tx.get(ref);
      if (snap.exists && (snap.data() as SubdomainClaim).funnelId !== claim.funnelId) {
        throw new SubdomainTakenError(next);
      }
      tx.set(ref, { ...claim, claimedAt: FieldValue.serverTimestamp() });
    }
    if (previous) {
      const prevRef = db.doc(`funnelSubdomains/${previous}`);
      const prevSnap = await tx.get(prevRef);
      // Only release what this funnel actually owns — never delete someone
      // else's claim because a stale doc still named it.
      if (
        prevSnap.exists &&
        (prevSnap.data() as SubdomainClaim).funnelId === claim.funnelId
      ) {
        tx.delete(prevRef);
      }
    }
  });
}

/** `7dsummer` → `7dsummer.leadstack.dev`, from NEXT_PUBLIC_APP_URL. Null when
 *  the app URL isn't set or is localhost (no real host to hang it off). */
export function subdomainHostname(name: string): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (!base) return null;
  try {
    const host = new URL(base).hostname.replace(/^www\./, "");
    if (host === "localhost" || host.endsWith(".localhost")) return null;
    return `${name}.${host}`;
  } catch {
    return null;
  }
}
