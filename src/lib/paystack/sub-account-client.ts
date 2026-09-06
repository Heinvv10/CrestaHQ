import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { paystackRequest } from "@/lib/paystack/client";
import {
  paystackConnectionSecretPath,
  type PaystackConnectionSecret,
} from "@/types/paystack-connection";

/**
 * The ONLY code path that reads a sub-account's own Paystack secret key.
 *
 * Keeping the read in one place is what makes the secret boundary auditable:
 * grep for `readPaystackConnectionSecret` and you have every consumer. Do not
 * read `subAccounts/{id}/private/paystackConnection` inline anywhere else.
 *
 * NOT `PAYSTACK_SECRET_KEY` — that is the AGENCY's account, used by Client
 * Billing to charge the sub-account. This is the sub-account charging ITS
 * customers. Confusing the two moves money into the wrong balance.
 */

/** Read the server-only secret doc. Returns null when never connected. */
export async function readPaystackConnectionSecret(
  subAccountId: string,
): Promise<PaystackConnectionSecret | null> {
  const snap = await getAdminDb()
    .doc(paystackConnectionSecretPath(subAccountId))
    .get();
  if (!snap.exists) return null;
  const key = (snap.data() as { secretKey?: string } | undefined)?.secretKey;
  if (!key) return null;
  return { secretKey: key };
}

/**
 * Prove a pasted key works BEFORE it is stored, and collect the one piece of
 * display metadata Paystack will give us for free.
 *
 * `GET /balance` is the probe because it is the cheapest authenticated call
 * that every live and test account answers, and its currencies tell a South
 * African operator whether they pasted a ZAR account or (say) their NGN one.
 * Paystack exposes no account-name endpoint comparable to Stripe's
 * `accounts.retrieve()`, so there is no business name to show — inventing one
 * from an undocumented endpoint would be worse than showing nothing.
 *
 * Throws whatever `paystackRequest` throws (a `BillingError` carrying
 * Paystack's own message); the caller turns that into the operator's error.
 */
export async function probePaystackKey(
  secretKey: string,
): Promise<{ currencies: string[] }> {
  const balances = await paystackRequest<{ currency?: string }[]>(
    "GET",
    "/balance",
    undefined,
    secretKey,
  );
  const currencies = Array.isArray(balances)
    ? [...new Set(balances.map((b) => b?.currency).filter((c): c is string => !!c))]
    : [];
  return { currencies };
}
