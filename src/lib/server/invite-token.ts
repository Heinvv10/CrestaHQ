import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Single-use invite tokens. The raw token travels only in the invite link
 * (`/signup?email=…&invite=<token>`); the invite doc stores its SHA-256
 * `tokenHash`. Signup must present a token whose hash matches — knowing the
 * invitee's email address is not enough to claim their invite.
 */
export function generateInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare of a presented token against a stored hash. */
export function inviteTokenMatches(
  token: string | undefined,
  tokenHash: unknown,
): boolean {
  if (!token || typeof tokenHash !== "string") return false;
  const a = Buffer.from(hashInviteToken(token), "hex");
  const b = Buffer.from(tokenHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
