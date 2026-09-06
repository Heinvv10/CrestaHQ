import "server-only";

/**
 * Operator-facing wording for a bridge rail refusal.
 *
 * The bridge already returns a machine-readable `refusedBy` code precisely so
 * a consumer can "render a real reason instead of a generic failure"
 * (rails/types.go). The CRM was not doing that: it concatenated the code and
 * the internal reason into one developer string —
 *
 *   WhatsApp bridge 422: consecutive_cap: 3 unanswered messages already sent
 *   to this contact (cap 3)
 *
 * — and the composer, seeing a 502, showed "Couldn't send." Neither tells an
 * operator what to DO, which is the only thing a refusal toast is for.
 *
 * Every message here answers "what now?", not "what happened". Where the
 * answer is "wait for the contact", it says so, because the alternative is an
 * operator retrying into a rail that exists to stop exactly that.
 */
/**
 * Every rail the bridge can refuse with, mirroring RefusalCode in
 * services/wa-agent-bridge/rails/types.go. Declared as a union so a rail added
 * to the map without being added here — or removed from here without being
 * removed from the map — fails to compile. refusals.test.ts covers the other
 * direction, which a type cannot: a rail added to the GO file and to neither.
 */
export type WaRefusalCode =
  | "kill_switch"
  | "consumer_budget"
  | "reply_only"
  | "per_contact_cap"
  | "consecutive_cap"
  | "daily_cap"
  | "quiet_hours"
  | "internal_error"
  | "in_flight"
  | "idempotency_key_reused";

const MESSAGES: Record<WaRefusalCode, string> = {
  consecutive_cap:
    "This contact hasn't replied to your last few messages, so WhatsApp would read more as spam. Wait for them to reply — that resets it.",
  reply_only:
    "This contact has never messaged this number, so we can't message them first. They have to start the conversation.",
  quiet_hours:
    "It's outside sending hours (21:00–07:00). Replying to someone who messaged in the last 24 hours still works.",
  per_contact_cap:
    "This contact has already had its daily message limit from this number.",
  daily_cap: "This number has sent its maximum for the last 24 hours. Capacity comes back gradually as older messages age out, not at midnight.",
  consumer_budget:
    "This workspace has hit its WhatsApp sending limit for now. It resets on the hour.",
  kill_switch:
    "Sending is stopped for this number. An operator has to lift the kill switch before anything goes out.",
  in_flight:
    "That message is already being sent. Give it a moment before trying again.",
  idempotency_key_reused:
    "Something went wrong sending that message and it was not delivered. Try again.",
  internal_error:
    "The WhatsApp bridge could not check its own limits, so it refused to send. This needs an operator.",
};

/**
 * Indexed by a plain string on purpose: `refusedBy` arrives over HTTP from a
 * bridge that may be running an older or newer build than this CRM, so a code
 * outside the union is a real runtime case and the caller falls back to the
 * provider's own words.
 */
export const WA_REFUSAL_MESSAGES: Readonly<Record<string, string>> = MESSAGES;

/**
 * A refusal is the provider deliberately declining, not a broken gateway.
 *
 * 409 rather than 502 matters for two reasons: 502 says "bad gateway", which
 * is untrue and sends whoever reads it hunting an infrastructure fault; and a
 * 5xx invites proxies, CDNs and retry logic to treat it as transient and try
 * again, which is the one thing these rails exist to prevent.
 */
export const WA_REFUSAL_STATUS = 409;
