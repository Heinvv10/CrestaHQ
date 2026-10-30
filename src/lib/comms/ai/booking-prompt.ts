import { hostSelectionEnabled } from "@/lib/booking/page-slots";
import {
  formatSlotForSpeech,
  type AgentBookingChannel,
  type AgentBookingLocation,
  type ChangeableBooking,
} from "@/lib/comms/ai/booking-engine";
import type { BookingHost, BookingPage, IntakeField } from "@/types/booking";

/**
 * The prompt half of the AI booking tools (booking-tools.ts runs the
 * markers): the system-prompt block that teaches the markers, host-name
 * resolution, and the labels the model sees. No email or Firestore imports,
 * so the voice route can use it without pulling in the send path.
 */

export type BookingAudience = AgentBookingChannel;

export const TOOL_PREFIX: Record<BookingAudience, string> = {
  phone: "[SYSTEM TOOL RESULT — not the caller speaking]",
  "web-text": "[SYSTEM TOOL RESULT — not the visitor speaking]",
  "web-voice": "[SYSTEM TOOL RESULT — not the visitor speaking]",
  messaging: "[SYSTEM TOOL RESULT — not the customer speaking]",
};

export function who(audience: BookingAudience): string {
  if (audience === "phone") return "caller";
  return audience === "messaging" ? "customer" : "visitor";
}

/** "No preference" phrases: pooled (first available), never a host name. */
const ANY_HOST_PHRASES = new Set([
  "anyone",
  "any",
  "anybody",
  "anyone available",
  "first available",
  "no preference",
  "whoever",
  "whoever's available",
  "whoever is available",
  "doesn't matter",
]);

/**
 * Case-insensitive: exact display name first, then a unique prefix match
 * ("Jane" -> "Jane Smith"). Ambiguous or unknown -> null.
 */
function resolveHostByName(page: BookingPage, spoken: string): BookingHost | null {
  const hosts = page.hosts ?? [];
  const q = spoken.trim().toLowerCase();
  if (!q) return null;
  const exact = hosts.find((h) => h.name.trim().toLowerCase() === q);
  if (exact) return exact;
  const starts = hosts.filter((h) =>
    h.name.trim().toLowerCase().startsWith(q),
  );
  return starts.length === 1 ? starts[0] : null;
}

/**
 * Host uid from a marker's host="…" value (null = pooled). `invalid` means a
 * name was given but didn't resolve; callers treat that as its own outcome,
 * not a scheduling conflict.
 */
export function resolveRequestedHost(
  page: BookingPage,
  spoken: string,
): { hostUid: string | null; invalid: boolean } {
  if (!spoken) return { hostUid: null, invalid: false };
  if (ANY_HOST_PHRASES.has(spoken.toLowerCase())) {
    return { hostUid: null, invalid: false };
  }
  const host = resolveHostByName(page, spoken);
  return host
    ? { hostUid: host.uid, invalid: false }
    : { hostUid: null, invalid: true };
}

export function invalidHostResult(page: BookingPage, audience: BookingAudience): string {
  const names = (page.hosts ?? []).map((h) => h.name).join(", ");
  return `${TOOL_PREFIX[audience]} That name isn't one of our team members — this is NOT a scheduling conflict and NOT a booking error. Our team members are: ${names}. Ask the ${who(audience)} which of them they'd like (or offer "anyone available"), then re-emit the marker with host="<exact name>" — or omit host for anyone.`;
}

/** Only pages that assign one host per booking (round-robin, service) offer a choice. */
export function hostSelectionOn(page: BookingPage): boolean {
  return hostSelectionEnabled(page);
}

/** A changeable booking as the model sees it: a short ref instead of the event id. */
export interface ChangeTarget {
  ref: string;
  booking: ChangeableBooking;
}

export function toChangeTargets(bookings: ChangeableBooking[]): ChangeTarget[] {
  return bookings.map((booking, i) => ({ ref: `b${i + 1}`, booking }));
}

export function changeLabel(t: ChangeTarget): string {
  const when = formatSlotForSpeech(t.booking.startAt, t.booking.page.timezone);
  const withHost = t.booking.assignedToName ? ` with ${t.booking.assignedToName}` : "";
  return `${t.booking.page.name} on ${when}${withHost}`;
}

/** The [[book]] attributes the model must include, per audience. */
export function bookMarkerExample(
  audience: BookingAudience,
  withHost: boolean,
  intakeCount: number,
): string {
  const host = withHost ? ' host="…"' : "";
  const q = intakeCount > 0 ? ' q1="…"' + (intakeCount > 1 ? " …" : "") : "";
  if (audience === "web-text") return `[[book start="…" name="…" email="…"${host}${q}]]`;
  if (audience === "web-voice") {
    return `[[book start="…" name="…" phone="…"${host}${q}]] (or email="…" instead of phone)`;
  }
  return `[[book start="…" name="…"${host}${q}]]`;
}

function intakeBlock(fields: IntakeField[], audience: BookingAudience): string {
  if (fields.length === 0) return "";
  const lines = fields.map((f, i) => {
    const opts =
      f.type === "select" && f.options?.length
        ? ` — answer must be one of: ${f.options.join(" / ")}`
        : "";
    return `- q${i + 1}: ${f.label}${f.required ? " (required)" : " (optional, ask if it fits naturally)"}${opts}`;
  });
  return `
QUESTIONS BEFORE BOOKING: Ask the ${who(audience)} these, one at a time, before booking, and pass each answer in the [[book]] marker as q1="…", q2="…" (no double quotes or square brackets inside an answer):
${lines.join("\n")}`;
}

function changesBlock(targets: ChangeTarget[], audience: BookingAudience): string {
  if (targets.length === 0) return "";
  const person = who(audience);
  const list = targets.map((t) => `- ${t.ref}: ${changeLabel(t)}`).join("\n");
  return `
CHANGING AN EXISTING BOOKING: The ${person} has these upcoming appointments:
${list}
- To move one: respond with EXACTLY [[slots booking="<ref>"]] to get times it can move to, offer up to 3, and once they pick, respond with EXACTLY [[reschedule booking="<ref>" start="<exact start value>"]].
- To cancel one: first confirm which appointment and that they really want to cancel, then respond with EXACTLY [[cancel booking="<ref>"]].
Never cancel or move an appointment the ${person} didn't clearly ask to change.`;
}

/**
 * System-prompt section that teaches the markers. Appended after the
 * channel's own rules. `page` null = no new bookings (changes only).
 */
export function buildBookingToolsBlock(
  page: BookingPage | null,
  audience: BookingAudience,
  extras: {
    intake?: IntakeField[] | null;
    changeable?: ChangeTarget[];
    /** The person's phone is already known (caller ID, a texting contact). */
    knownPhone?: boolean;
    /** Where the page's meetings happen. Absent = not set. */
    location?: AgentBookingLocation | null;
  } = {},
): string {
  const intake = page ? (extras.intake ?? []) : [];
  const tail = `${page ? locationBlock(extras.location ?? null, audience, extras.knownPhone === true) : ""}${intakeBlock(intake, audience)}${changesBlock(extras.changeable ?? [], audience)}`;

  if (!page) {
    return `--- LIVE BOOKING TOOLS ---
Markers (the system intercepts them; the ${who(audience)} never sees or hears them).${tail}
Rules: never invent or confirm a time that didn't come from the system. COPY start values character-for-character, and never show or say raw start values or ISO dates.`;
  }

  const team = (page.hosts ?? []).map((h) => h.name).join(", ");
  if (audience === "phone") {
    const hostBlock = hostSelectionOn(page)
      ? `
HOST SELECTION: This business lets the caller book with a specific team member. Our team: ${team}. EARLY in the booking — before offering times — ask the caller which team member they'd like, or whether anyone available is fine. Pass their choice as host="<team member's name>" in BOTH markers: [[slots host="<name>"]] and [[book start="…" name="…" host="<name>"]]. If the caller has no preference, OMIT the host attribute (or use host="anyone") and the system picks the least-busy person. Only offer the times the system returns for the chosen person.`
      : "";
    return `--- LIVE BOOKING TOOLS ---
You can book real appointments for the caller on the business's "${page.name}" calendar (${page.durationMinutes}-minute slots, times in ${page.timezone}). This SUPERSEDES the earlier booking guidance: book directly during this call instead of promising a texted link — only fall back to the link if no offered time suits the caller.
Markers (the system intercepts them; the caller never hears them):
1. When the caller wants to book, schedule, or pick a time, respond with EXACTLY [[slots]] and nothing else. The system hands you the available times.
2. Offer AT MOST 3 of those times conversationally (day + time, e.g. "Tuesday at ten a.m."). Ask which works.
3. When the caller chooses a time AND you know their first name (ask for it first if you don't), respond with EXACTLY [[book start="<the exact start value of the chosen slot>" name="<caller's first name>"]] and nothing else.
4. The system reports the result; confirm to the caller in one short sentence.${hostBlock}${tail}
Rules: never invent or confirm a time that didn't come from [[slots]]. COPY the start value character-for-character from the [[slots]] result — never retype, reformat, shorten, or reconstruct a timestamp from the day/time you spoke aloud. Never read raw start values or dates in ISO format aloud. If the system says a time was just taken, apologise and offer the alternatives it provides.`;
  }

  const person = who(audience);
  const hostBlock = hostSelectionOn(page)
    ? `
HOST SELECTION: This business lets the ${person} book with a specific team member. Our team: ${team}. Before offering times, ask which team member they'd like, or whether anyone available is fine. Pass their choice as host="<team member's name>" in BOTH markers. If they have no preference, OMIT the host attribute (or use host="anyone") and the system picks the least-busy person. Only offer the times the system returns for the chosen person.`
    : "";
  const identity =
    audience === "web-text"
      ? `their name AND email address (the confirmation and calendar invite go to that email; a phone number is optional — add phone="…" if they give one)`
      : audience === "web-voice"
        ? `their name AND a phone number or email address. Read it back in spoken form ("jane at example dot com", or the digits in small groups) and wait for them to confirm before booking`
        : `their name (an email address is optional — add email="…" if they give one so they get a confirmation email and calendar invite)`;
  const offerStep =
    audience === "web-text"
      ? `2. The visitor also sees the times as buttons they can tap. In your reply, mention up to 3 of them briefly (day + time) and ask which works. Never list raw start values.`
      : audience === "web-voice"
        ? `2. Offer AT MOST 3 of those times conversationally (day + time, e.g. "Tuesday at ten a.m."). Ask which works. The times also appear as buttons on their screen; a message like "I'll take Tue, Oct 27, 10:00 AM" means they tapped that time.`
        : `2. Offer AT MOST 3 of those times conversationally (day + time, e.g. "Tuesday at ten a.m."). Ask which works.`;
  return `--- LIVE BOOKING TOOLS ---
You can book real appointments for the ${person} on the business's "${page.name}" calendar (${page.durationMinutes}-minute slots, times in ${page.timezone}). This SUPERSEDES the earlier booking guidance: book directly in this conversation instead of sending the booking link — only share the link if no offered time suits the ${person}.
Markers (the system intercepts them; the ${person} never sees or hears them):
1. When the ${person} wants to book, schedule, or pick a time, respond with EXACTLY [[slots]] and nothing else. The system hands you the available times.
${offerStep}
3. Before booking you need ${identity}. Ask for anything missing, one thing at a time. Do NOT use a [[form]] or [[capture]] marker for this — the booking marker captures their details.
4. When the ${person} has chosen a time AND you have their details, respond with EXACTLY ${bookMarkerExample(audience, false, intake.length)} using the exact start value of the chosen slot, and nothing else.
5. The system reports the result; confirm it to the ${person} briefly.${hostBlock}${tail}
Rules: never invent or confirm a time that didn't come from the system. COPY the start value character-for-character — never retype, reformat or reconstruct a timestamp. Never show or say raw start values or ISO dates. If the system says a time was just taken, apologise and offer the alternatives it provides.`;
}

/** Prompt lines telling the agent where the meeting happens and what to collect for it. */
function locationBlock(
  location: AgentBookingLocation | null,
  audience: BookingAudience,
  knownPhone: boolean,
): string {
  const line = location?.description.trim();
  if (!location || !line) return "";
  const person = who(audience);
  const extra =
    location.type === "we_call"
      ? knownPhone
        ? ` The business will call them on the number they're ${audience === "phone" ? "calling" : "messaging"} from unless they give another (then add phone="…").`
        : ` You need their phone number for this: include phone="…" in the [[book]] marker.`
      : location.type === "their_address"
        ? ` You need the full address of the visit: include address="…" in the [[book]] marker${audience === "phone" || audience === "web-voice" ? " (read it back first)" : ""}.`
        : "";
  return `
WHERE: ${line}. Tell the ${person} how the meeting happens when you offer or confirm a time.${extra}`;
}
