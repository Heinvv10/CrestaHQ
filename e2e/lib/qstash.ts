import { createHash, createHmac } from "node:crypto";
import { requireQStashSigningKey } from "./env";

/**
 * Mint the `upstash-signature` that /api/workflows/step verifies.
 *
 * QStash cannot deliver to 127.0.0.1, so the enrol spec plays QStash itself.
 * The scheme below is not invented — it is exactly what
 * `verifyQStashSignature` (src/lib/automations/qstash.ts) accepts, which is
 * Upstash's `Receiver.verify`:
 *
 *   jose.jwtVerify(signature, encode(signingKey), { issuer: "Upstash" })
 *   ...then p.sub === url (only when a url is supplied — the app passes none)
 *   ...then SHA256(body) base64url === p.body, padding-insensitive.
 *
 * So: an HS256 JWT signed with QSTASH_CURRENT_SIGNING_KEY, `iss: "Upstash"`,
 * `sub` the callback URL, and `body` the base64url SHA-256 of the raw body.
 * The Receiver tries the current key first, so signing with current is enough.
 */

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signQStashBody(url: string, body: string): string {
  const key = requireQStashSigningKey();
  const now = Math.floor(Date.now() / 1000);

  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "Upstash",
      sub: url,
      iat: now,
      nbf: now,
      exp: now + 300,
      jti: b64url(String(now) + Math.random()),
      body: createHash("sha256").update(body, "utf8").digest("base64url"),
    }),
  );
  const signature = createHmac("sha256", key)
    .update(`${header}.${payload}`)
    .digest("base64url");

  return `${header}.${payload}.${signature}`;
}
