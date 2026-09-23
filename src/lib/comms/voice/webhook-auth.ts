import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Authenticate a Vapi webhook by its `?s=` secret — the value provisioning
 * bakes into each assistant's server URL (a query param because Vapi's
 * custom-LLM URL can't carry a custom header). Constant-time: both sides are
 * hashed to a fixed length first, so neither the compare nor a length check
 * leaks how much of a guess matched.
 *
 * ONE deployment-wide secret (VAPI_WEBHOOK_SECRET): the route's
 * [subAccountId] is routing only, so this proves "Vapi called", never "Vapi
 * called for THIS sub-account".
 */
export function vapiWebhookAuthorized(request: Request): boolean {
  const expected = process.env.VAPI_WEBHOOK_SECRET?.trim();
  if (!expected) return false;
  const provided = new URL(request.url).searchParams.get("s")?.trim() ?? "";
  if (!provided) return false;
  const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(digest(provided), digest(expected));
}
