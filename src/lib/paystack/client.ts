import "server-only";

import { BillingError } from "@/lib/billing/errors";

const PAYSTACK_BASE_URL = "https://api.paystack.co";

/**
 * Every Paystack response is `{ status, message, data }`. `status: false` is a
 * refusal the caller must handle even when the HTTP code is 200, so success is
 * decided on the envelope, never on the status code alone.
 */
interface PaystackEnvelope<T> {
  status: boolean;
  message?: string;
  data?: T;
}

/** True when this deployment has a Paystack secret key. */
export function paystackIsConfigured(): boolean {
  return !!process.env.PAYSTACK_SECRET_KEY?.trim();
}

function secretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY?.trim();
  if (!key) {
    throw new BillingError("Paystack isn't configured on this deployment.", 503);
  }
  return key;
}

/**
 * One call to Paystack's REST API.
 *
 * Failures surface as `BillingError` so they travel the same path as every
 * other Client Billing failure and reach the operator as a message rather than
 * a 500. Paystack's own `message` is passed through — it is written for
 * humans ("Customer not found", "Plan code is invalid") and is more useful
 * than anything this layer could invent.
 */
export async function paystackRequest<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey()}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
    });
  } catch (err) {
    throw new BillingError(
      `Couldn't reach Paystack: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  let payload: PaystackEnvelope<T> | null = null;
  try {
    payload = (await response.json()) as PaystackEnvelope<T>;
  } catch {
    // Fall through to the status-code error below — a body we can't parse
    // tells us nothing, and inventing a reason would be worse than saying so.
  }

  if (!response.ok || !payload?.status) {
    throw new BillingError(
      payload?.message
        ? `Paystack: ${payload.message}`
        : `Paystack returned ${response.status}.`,
      // 4xx is our request's fault and is worth showing verbatim; anything
      // else is Paystack being unavailable.
      response.status >= 400 && response.status < 500 ? 400 : 502,
    );
  }

  if (payload.data === undefined) {
    throw new BillingError("Paystack returned no data.", 502);
  }
  return payload.data;
}
