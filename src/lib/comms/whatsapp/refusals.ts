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
  // The rail names a remedy this message used to hide: an operator can
  // allowlist the contact (checkReplyOnly, "add them to the allowlist to
  // override"). Saying only "they have to start the conversation" told an
  // operator the situation was out of their hands when it was not.
  reply_only:
    "This contact has never messaged this number, so it cannot message them first. Either they start the conversation, or an operator allowlists them for this number.",
  // Names no clock value: the window is a deployment default, overridable
  // globally AND per consumer (CONSUMERS fields 7 and 8), in a configurable
  // timezone. The old wording also inverted it - "outside sending hours
  // (21:00-07:00)" reads as though those ARE the sending hours - and promised
  // the reply exemption unconditionally, which is false wherever
  // HUMAN_REPLY_SESSION_HOURS is 0.
  quiet_hours:
    "It's inside this number's quiet hours, so outreach is held until they end. A reply to a contact who messaged recently normally still goes out.",
  // Rolling 24 hours (caps.go: dayAgo), not a calendar day - the same
  // mistake as daily_cap, made in the same sitting.
  per_contact_cap:
    "This contact has already had the maximum number of messages from this number in the last 24 hours.",
  // A ROLLING 24 hours (caps.go: Now.Add(-24*time.Hour)), not a calendar day.
  // Waiting for midnight after a 23:00 burst is refused again.
  daily_cap:
    "This number has hit its sending limit for the last 24 hours. Capacity frees up as earlier messages age out, so try again later rather than at midnight.",
  // THREE conditions share this code (window.go:28,37,46): a rolling hourly
  // cap, a rolling daily one, and - not a limit at all - "consumer has no
  // registered budget", a missing CONSUMERS entry that never clears on its
  // own. Promising a reset was the most harmful line in this map: it sent an
  // operator away to wait out a permanent configuration error.
  consumer_budget:
    "This workspace has hit its WhatsApp sending allowance. If it has been quiet for a while and this keeps happening, the bridge may have no budget configured for this workspace - that needs an operator.",
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
