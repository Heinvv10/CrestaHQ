import "server-only";

import type { SlotCandidate } from "@/lib/booking/availability";
import { hostSelectionEnabled } from "@/lib/booking/page-slots";
import { emailIsConfigured, type EmailAccount } from "@/lib/comms/resend";
import {
  formatSlotForSpeech,
  type AgentBookingChannel,
  type AgentBookingEngine,
  type AgentBookingLocation,
  type AgentBookResult,
  type ChangeableBooking,
} from "@/lib/comms/ai/booking-engine";
import type { BookingHost, BookingPage, IntakeField } from "@/types/booking";

/**
 * Live booking "tools" for agents that run in custom-LLM style (phone voice,
 * website chat and voice, SMS/WhatsApp/Messenger). We are the LLM, so tools
 * are markers the model emits and we intercept before the reply is shown or
 * spoken: run the real service, feed the result back as a labelled message,
 * and let the model phrase the reply.
 *
 *   [[slots host="…"]]                                 open times for a new booking
 *   [[book start="…" name="…" email="…" phone="…" host="…" q1="…"]]   book one
 *   [[slots booking="b1"]]                             times to move booking b1 to
 *   [[reschedule booking="b1" start="…"]]              move it
 *   [[cancel booking="b1"]]                            cancel it
 *
 * Callers must strip any leftover [[…]] before the text reaches a person; a
 * marker can survive when the tool-round cap is hit.
 *
 * The engine (slots, reschedule slots) is passed in as `engine`, and the
 * page's location as `location`, so this module has no Firestore access.
 */

export type BookingAudience = AgentBookingChannel;

// Lazy up to the first "]]" so a stray "]" inside an answer can't hide a marker.
const SLOTS_MARKER_RE = /\[\[\s*slots\b([\s\S]*?)\]\]/i;
const BOOK_MARKER_RE = /\[\[\s*book\b([\s\S]*?)\]\]/i;
const RESCHEDULE_MARKER_RE = /\[\[\s*reschedule\b([\s\S]*?)\]\]/i;
const CANCEL_MARKER_RE = /\[\[\s*cancel\b([\s\S]*?)\]\]/i;
/** Every marker this module understands, for stripping leftovers. */
export const ANY_BOOKING_MARKER_RE =
  /\[\[\s*(?:slots|book|reschedule|cancel)\b[\s\S]*?\]\]/gi;
/**
 * Only the head of a reply is scanned for a marker. A marker is the whole
 * reply, so a real one is short; the lazy patterns cost the square of the
 * text length on a reply with many unclosed "[[book".
 */
const MAX_SCAN_CHARS = 16_000;

const TOOL_PREFIX: Record<BookingAudience, string> = {
  phone: "[SYSTEM TOOL RESULT — not the caller speaking]",
  "web-text": "[SYSTEM TOOL RESULT — not the visitor speaking]",
  "web-voice": "[SYSTEM TOOL RESULT — not the visitor speaking]",
  messaging: "[SYSTEM TOOL RESULT — not the customer speaking]",
};

function who(audience: BookingAudience): string {
  if (audience === "phone") return "caller";
  return audience === "messaging" ? "customer" : "visitor";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isPlausiblePhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
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

function attr(attrs: string, key: string): string {
  return (
    new RegExp(`(?:^|\\s)${key}\\s*=\\s*"([^"]*)"`, "i").exec(attrs)?.[1]?.trim() ?? ""
  );
}

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

function changeLabel(t: ChangeTarget): string {
  const when = formatSlotForSpeech(t.booking.startAt, t.booking.page.timezone);
  const withHost = t.booking.assignedToName ? ` with ${t.booking.assignedToName}` : "";
  return `${t.booking.page.name} on ${when}${withHost}`;
}

/** Offered-time keys: a reschedule offer can't be used to make a new booking and vice versa. */
export function bookOfferKey(pageSlug: string, iso: string): string {
  return `book:${pageSlug}|${normalizeIso(iso)}`;
}
export function rescheduleOfferKey(eventId: string, iso: string): string {
  return `move:${eventId}|${normalizeIso(iso)}`;
}

/** The [[book]] attributes the model must include, per audience. */
function bookMarkerExample(
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

/** What a [[book]] marker asked for, after identity and intake checks. */
export interface BookRequest {
  startAtIso: string;
  name: string;
  email: string | null;
  phone: string | null;
  hostUid: string | null;
  intakeAnswers: { label: string; value: string }[];
  /** The booker's address, for "at your place" pages. */
  address: string | null;
}

/** `limit` = a cap was hit for this conversation, this visitor, or the whole workspace today. */
export type BookToolResult =
  | AgentBookResult
  | { ok: false; code: "limit"; scope: "chat" | "visitor" | "workspace" };

export type ChangeToolResult =
  | { ok: true }
  | { ok: false; code: "slot_taken" | "invalid" | "error" | "limit" }
  | { ok: false; code: "bad_state"; message: string };

export interface BookingToolOutcome {
  /** Labelled tool-result message to feed back to the model. */
  toolResult: string;
  /** Times shown this round, with the keys a later marker may use. */
  offered?: {
    slots: SlotCandidate[];
    hostUid: string | null;
    page: BookingPage;
    keys: string[];
    /** Set when the times are for moving an existing booking. */
    moveEventId?: string;
  };
  booked?: { eventId: string; startAt: Date; label: string };
  changed?: { kind: "cancelled" | "rescheduled"; eventId: string; label: string };
}

function slotLines(slots: SlotCandidate[], page: BookingPage): string {
  return slots
    .map(
      (s) =>
        `- start="${s.startAt.toISOString()}" → ${formatSlotForSpeech(s.startAt, page.timezone)}`,
    )
    .join("\n");
}

/** Missing-identity message, or null when the request has what this audience needs. */
function identityProblem(
  audience: BookingAudience,
  req: { name: string; email: string; phone: string },
  intakeCount: number,
): string | null {
  const prefix = TOOL_PREFIX[audience];
  const example = bookMarkerExample(audience, false, intakeCount);
  if (audience === "phone") {
    return req.name
      ? null
      : `${prefix} You must know the caller's first name before booking. Ask for their name, then emit the [[book …]] marker again with it.`;
  }
  if (audience === "messaging") {
    return req.name
      ? null
      : `${prefix} Not booked yet — you need the customer's name first. Ask for it, then emit ${example} again.`;
  }
  const emailOk = EMAIL_RE.test(req.email);
  const phoneOk = isPlausiblePhone(req.phone);
  if (audience === "web-text") {
    if (req.name && emailOk) return null;
    return `${prefix} Not booked yet — you need the visitor's name and a valid email address first.${req.email && !emailOk ? ` "${req.email}" isn't a valid email address.` : ""} Ask for whatever is missing, then emit ${example} again.`;
  }
  if (req.name && (emailOk || phoneOk)) return null;
  return `${prefix} Not booked yet — you need the visitor's name and a phone number or email address first (read it back and confirm). Ask for whatever is missing, then emit ${example} again.`;
}

/**
 * What the page's location needs from the person, or null when it has it.
 * `knownPhone` covers caller ID and a texting contact's number.
 */
function locationProblem(
  audience: BookingAudience,
  location: AgentBookingLocation | null,
  req: { phone: string; address: string },
  knownPhone: boolean,
): string | null {
  const type = location?.type;
  const prefix = TOOL_PREFIX[audience];
  const person = who(audience);
  if (type === "we_call" && !knownPhone && !isPlausiblePhone(req.phone)) {
    return `${prefix} Not booked yet — this is a phone call where the business calls the ${person}, so you need their phone number. Ask for it, then emit the [[book]] marker again with phone="…".`;
  }
  if (type === "their_address" && req.address.length < 5) {
    return `${prefix} Not booked yet — the meeting is at the ${person}'s address, so you need the full address of the visit. Ask for it${audience === "phone" || audience === "web-voice" ? " and read it back" : ""}, then emit the [[book]] marker again with address="…".`;
  }
  return null;
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

/** Answers keyed q1..qN in page order, validated like the public booking route. */
function parseIntake(
  attrs: string,
  fields: IntakeField[],
): { answers: { label: string; value: string }[]; problems: string[] } {
  const answers: { label: string; value: string }[] = [];
  const problems: string[] = [];
  fields.forEach((f, i) => {
    let value = attr(attrs, `q${i + 1}`).slice(0, 500);
    if (f.type === "select" && value) {
      const match = (f.options ?? []).find(
        (o) => o.trim().toLowerCase() === value.toLowerCase(),
      );
      if (!match) {
        problems.push(`q${i + 1} (${f.label}) must be one of: ${(f.options ?? []).join(" / ")}`);
        return;
      }
      value = match;
    }
    if (!value) {
      if (f.required) problems.push(`q${i + 1} (${f.label}) is required`);
      return;
    }
    answers.push({ label: f.label, value });
  });
  return { answers, problems };
}

export interface RunBookingToolInput {
  modelText: string;
  audience: BookingAudience;
  subAccountId: string;
  /** Slot listing for new bookings and moves (agent-booking-service). */
  engine: AgentBookingEngine;
  /** The sub-account doc: decides whether a confirmation email can go out. */
  emailAccount: EmailAccount | null;
  /** Where the page's meetings happen. Absent = not set. */
  location?: AgentBookingLocation | null;
  /** Page new bookings go on. Null = no new bookings this turn (changes only). */
  page: BookingPage | null;
  /** Intake questions to require on [[book]]; null/empty = none. */
  intake?: IntakeField[] | null;
  /** The person's phone is already known (caller ID, a texting contact). */
  knownPhone?: boolean;
  /** Bookings this conversation may cancel or move. */
  changeable?: ChangeTarget[];
  book: (req: BookRequest) => Promise<BookToolResult>;
  /**
   * Checked before the offered-times gate: a booking this conversation already
   * made for the same time (a provider retry of the same message) is reported
   * as booked instead of failing the gate or the slot check.
   */
  findExisting?: (req: BookRequest) => Promise<AgentBookResult | null>;
  cancel?: (target: ChangeTarget) => Promise<ChangeToolResult>;
  reschedule?: (target: ChangeTarget, startAtIso: string) => Promise<ChangeToolResult>;
  /** Offered-time keys that may be used. Null = any valid slot (phone). */
  allowedKeys?: ReadonlySet<string> | null;
  /** Booking intent seen (slots asked for, or a book attempt that didn't land). */
  onAttempt?: () => void;
}

/**
 * Runs a booking marker if the text has one and returns the outcome; null
 * means the text is the final reply. Failures come back as instructive tool
 * results, never throws, so the conversation can't break.
 */
export async function runBookingTool(
  input: RunBookingToolInput,
): Promise<BookingToolOutcome | null> {
  const { audience, subAccountId } = input;
  const modelText = input.modelText.slice(0, MAX_SCAN_CHARS);
  const prefix = TOOL_PREFIX[audience];
  const person = who(audience);

  const bookMatch = BOOK_MARKER_RE.exec(modelText);
  if (bookMatch) {
    return input.page
      ? runBook(input, input.page, bookMatch[1] ?? "")
      : noNewBookings(audience);
  }

  const changeable = input.changeable ?? [];
  const findTarget = (attrs: string): ChangeTarget | null => {
    const ref = attr(attrs, "booking").toLowerCase();
    return changeable.find((t) => t.ref === ref) ?? null;
  };
  const unknownTarget = (): BookingToolOutcome => ({
    toolResult: changeable.length
      ? `${prefix} That booking reference isn't one of this ${person}'s upcoming appointments. Use one of: ${changeable.map((t) => `${t.ref} (${changeLabel(t)})`).join("; ")}.`
      : `${prefix} There are no upcoming appointments you can change in this conversation. Offer the reschedule/cancel link from their confirmation email, or have the team follow up.`,
  });

  const rescheduleMatch = RESCHEDULE_MARKER_RE.exec(modelText);
  if (rescheduleMatch && input.reschedule) {
    const attrs = rescheduleMatch[1] ?? "";
    const target = findTarget(attrs);
    if (!target) return unknownTarget();
    const startAtIso = attr(attrs, "start");
    // Without stored offers (phone: its history only carries speech) the start
    // must still be one of the times the booking can move to right now, so a
    // rebuilt or shifted timestamp re-lists instead of moving the wrong slot.
    const allowed = input.allowedKeys
      ? input.allowedKeys.has(rescheduleOfferKey(target.booking.eventId, startAtIso))
      : await isCurrentMoveSlot(input, target, startAtIso);
    const result: ChangeToolResult =
      startAtIso && allowed
        ? await input.reschedule(target, startAtIso).catch((err: unknown) => {
            console.error(
              `[booking-tools] reschedule failed sa=${subAccountId}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return { ok: false, code: "error" } as const;
          })
        : { ok: false, code: "invalid" };
    if (result.ok) {
      const label = formatSlotForSpeech(new Date(startAtIso), target.booking.page.timezone);
      return {
        toolResult: `${prefix} Moved: ${target.booking.page.name} is now ${label}. Confirm it to the ${person} briefly${audience === "phone" ? "" : " and mention an updated confirmation is on its way if they have an email on file"}.`,
        changed: { kind: "rescheduled", eventId: target.booking.eventId, label },
      };
    }
    return rescheduleFailure(input, target, result);
  }

  const cancelMatch = CANCEL_MARKER_RE.exec(modelText);
  if (cancelMatch && input.cancel) {
    const target = findTarget(cancelMatch[1] ?? "");
    if (!target) return unknownTarget();
    const result = await input.cancel(target).catch((err: unknown) => {
      console.error(
        `[booking-tools] cancel failed sa=${subAccountId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false, code: "error" } as const;
    });
    if (result.ok) {
      return {
        toolResult: `${prefix} Cancelled: ${changeLabel(target)}. Confirm it to the ${person} briefly and offer to book another time if they'd like.`,
        changed: { kind: "cancelled", eventId: target.booking.eventId, label: changeLabel(target) },
      };
    }
    if (result.code === "limit") {
      return {
        toolResult: `${prefix} Not changed: this conversation has made the maximum number of changes for today. Tell the ${person} the team will follow up.`,
      };
    }
    if (result.code === "bad_state") {
      return { toolResult: `${prefix} Couldn't cancel: ${result.message} Tell the ${person}.` };
    }
    return {
      toolResult: `${prefix} Cancelling failed due to a system error. Apologise and tell the ${person} the team will follow up.`,
    };
  }

  const slotsMatch = SLOTS_MARKER_RE.exec(modelText);
  if (slotsMatch) {
    const attrs = slotsMatch[1] ?? "";
    if (attr(attrs, "booking")) {
      const target = findTarget(attrs);
      if (!target) return unknownTarget();
      return listMoveSlots(input, target);
    }
    if (input.page) return listBookSlots(input, input.page, attrs);
    return noNewBookings(audience);
  }

  return null;
}

async function runBook(
  input: RunBookingToolInput,
  page: BookingPage,
  attrs: string,
): Promise<BookingToolOutcome> {
  const { audience, subAccountId } = input;
  const prefix = TOOL_PREFIX[audience];
  const person = who(audience);
  const intake = input.intake ?? [];
  const startAtIso = attr(attrs, "start");
  const name = attr(attrs, "name").slice(0, 120);
  const email = attr(attrs, "email").toLowerCase().slice(0, 200);
  const phone = attr(attrs, "phone").slice(0, 40);
  // An unrecognised host name is its own outcome, not a slot problem.
  let hostUid: string | null = null;
  if (hostSelectionOn(page)) {
    const r = resolveRequestedHost(page, attr(attrs, "host"));
    if (r.invalid) {
      input.onAttempt?.();
      return { toolResult: invalidHostResult(page, audience) };
    }
    hostUid = r.hostUid;
  }
  const problem = identityProblem(audience, { name, email, phone }, intake.length);
  if (problem) return { toolResult: problem };
  const address = attr(attrs, "address").slice(0, 300);
  const whereProblem = locationProblem(
    audience,
    input.location ?? null,
    { phone, address },
    input.knownPhone === true,
  );
  if (whereProblem) return { toolResult: whereProblem };
  if (!startAtIso) {
    return {
      toolResult: `${prefix} The book marker was missing its start value. Emit [[slots]] to get fresh times, then book with the exact start value of the slot the ${person} chose.`,
    };
  }
  const parsedIntake = parseIntake(attrs, intake);
  if (parsedIntake.problems.length > 0) {
    return {
      toolResult: `${prefix} Not booked yet — ${parsedIntake.problems.join("; ")}. Ask the ${person}, then emit the [[book]] marker again with every answer.`,
    };
  }

  const req: BookRequest = {
    startAtIso,
    name,
    email: EMAIL_RE.test(email) ? email : null,
    phone: phone && isPlausiblePhone(phone) ? phone : null,
    hostUid,
    intakeAnswers: parsedIntake.answers,
    address: address || null,
  };
  try {
    // A replay check that can't run fails closed (the error branch below):
    // booking anyway could double-book a provider retry on another host.
    const existing = input.findExisting ? await input.findExisting(req) : null;
    const offeredOk =
      !input.allowedKeys || input.allowedKeys.has(bookOfferKey(page.slug, startAtIso));
    const result: BookToolResult = existing
      ? existing
      : offeredOk
        ? await input.book(req)
        : { ok: false, code: "invalid_slot" };
    if (result.ok) {
      const label = formatSlotForSpeech(result.startAt, page.timezone);
      const booked = { eventId: result.eventId, startAt: result.startAt, label };
      if (audience === "phone") {
        return {
          toolResult: `${prefix} Booked: ${label} (${page.durationMinutes} minutes). Confirm briefly to the caller — day and time only — and let them know it's locked in.`,
          booked,
        };
      }
      // Messaging sends to the contact's own email first, so don't name an address.
      const emailNote = !emailIsConfigured(input.emailAccount)
        ? ""
        : audience === "messaging"
          ? " If they have an email on file, a confirmation with a calendar invite is on its way."
          : EMAIL_RE.test(email)
            ? ` A confirmation email with a calendar invite is on its way to ${email} — mention that.`
            : "";
      const withHost = result.assignedToName ? ` with ${result.assignedToName}` : "";
      return {
        toolResult: `${prefix} Booked: ${label}${withHost} (${page.durationMinutes} minutes). Confirm it to the ${person} briefly — day and time.${emailNote}`,
        booked,
      };
    }
    if (result.code === "limit") {
      const why =
        result.scope === "chat"
          ? "this conversation has already made the maximum number of bookings"
          : "online booking is temporarily unavailable";
      return {
        toolResult: `${prefix} Not booked: ${why}. Don't try again; tell the ${person} the team will follow up to arrange a time.`,
      };
    }
    input.onAttempt?.();
    if (result.code === "error") {
      return {
        toolResult: `${prefix} Booking failed due to a system error. Apologise and tell the ${person} the team will follow up to lock in a time.`,
      };
    }
    // Not booked; include fresh alternatives so recovery needs no extra round.
    // `invalid_slot` almost always means the model rebuilt the timestamp
    // instead of copying start="..."; a "no longer available" message would
    // loop it on the same bad value, so tell it to copy exactly. A real
    // `slot_taken` gets the apologise-and-offer path.
    const alternatives = await input.engine
      .listAgentSlots(subAccountId, page, hostUid)
      .catch((err: unknown) => {
        console.warn(
          `[booking-tools] alternative slots failed sa=${subAccountId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [] as SlotCandidate[];
      });
    const altLines = slotLines(alternatives, page);
    const offered =
      alternatives.length > 0
        ? {
            slots: alternatives,
            hostUid,
            page,
            keys: alternatives.map((s) => bookOfferKey(page.slug, s.startAt.toISOString())),
          }
        : undefined;
    if (result.code === "invalid_slot") {
      return {
        toolResult: `${prefix} That start value wasn't a valid slot time — do NOT retype or reconstruct timestamps. Re-emit [[book]] using a start value COPIED EXACTLY (character-for-character) from the list below.${
          altLines
            ? `\n${altLines}`
            : " No times are currently loaded — emit [[slots]] first, then copy a start value from that result verbatim."
        }`,
        offered,
      };
    }
    return {
      toolResult: `${prefix} That time is no longer available. Apologise briefly.${
        altLines
          ? ` Offer up to 3 of these instead:\n${altLines}`
          : audience === "phone"
            ? " Nothing else is open in the next 7 days — offer to have the team follow up with times by text."
            : " Nothing else is open in the next 7 days — offer to have the team follow up with times."
      }`,
      offered,
    };
  } catch (err) {
    console.error(
      `[booking-tools] book tool failed sa=${subAccountId} slug=${page.slug}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      toolResult: `${prefix} Booking failed due to a system error. Apologise and tell the ${person} the team will follow up to lock in a time.`,
    };
  }
}

async function listBookSlots(
  input: RunBookingToolInput,
  page: BookingPage,
  attrs: string,
): Promise<BookingToolOutcome> {
  const { audience, subAccountId } = input;
  const prefix = TOOL_PREFIX[audience];
  const person = who(audience);
  const linkFallback =
    audience === "phone" ? "or text the booking link" : "or share the booking link";
  let hostUid: string | null = null;
  if (hostSelectionOn(page)) {
    const r = resolveRequestedHost(page, attr(attrs, "host"));
    if (r.invalid) {
      input.onAttempt?.();
      return { toolResult: invalidHostResult(page, audience) };
    }
    hostUid = r.hostUid;
  }
  // Asking for times is booking intent; record it for the follow-up task.
  input.onAttempt?.();
  try {
    const slots = await input.engine.listAgentSlots(subAccountId, page, hostUid);
    const forHost = hostUid
      ? ` for ${(page.hosts ?? []).find((h) => h.uid === hostUid)?.name ?? "the chosen host"}`
      : "";
    if (slots.length === 0) {
      return {
        toolResult: `${prefix} No available times${forHost} in the next 7 days. Tell the ${person} nothing's open this week${hostUid ? " with that person (offer another team member or anyone available)" : ""} and offer to have the team follow up (${linkFallback}).`,
      };
    }
    const lines = slotLines(slots, page);
    const intakeCount = (input.intake ?? []).length;
    const next =
      audience === "phone" && intakeCount === 0
        ? `Offer AT MOST 3 conversationally (day + time), ask which works, and when the caller picks one — and you have their first name — emit [[book start="…" name="…"${hostUid ? ' host="…"' : ""}]] with that slot's exact start value.`
        : `${audience === "web-text" ? `The ${person} sees these as buttons too. Mention up to 3 briefly (day + time)` : "Offer AT MOST 3 conversationally (day + time)"}, ask which works, and when the ${person} picks one — and you have their details${intakeCount > 0 ? " and answers" : ""} — emit ${bookMarkerExample(audience, hostUid !== null, intakeCount)} with that slot's exact start value.`;
    return {
      toolResult: `${prefix} Available times${forHost} (${page.timezone}):\n${lines}\n${next}`,
      offered: {
        slots,
        hostUid,
        page,
        keys: slots.map((s) => bookOfferKey(page.slug, s.startAt.toISOString())),
      },
    };
  } catch (err) {
    console.error(
      `[booking-tools] slots tool failed sa=${subAccountId} slug=${page.slug}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      toolResult: `${prefix} Couldn't load availability right now. Apologise and offer to have the team follow up with times.`,
    };
  }
}

async function listMoveSlots(
  input: RunBookingToolInput,
  target: ChangeTarget,
): Promise<BookingToolOutcome> {
  const { audience, subAccountId } = input;
  const prefix = TOOL_PREFIX[audience];
  const person = who(audience);
  const { page } = target.booking;
  try {
    const slots = await input.engine.listRescheduleSlots(subAccountId, page, {
      id: target.booking.eventId,
      assignedToUid: target.booking.assignedToUid,
    });
    if (slots.length === 0) {
      return {
        toolResult: `${prefix} No other times are open in the next 7 days for ${changeLabel(target)}. Tell the ${person} and offer to have the team follow up.`,
      };
    }
    return {
      toolResult: `${prefix} Times ${target.ref} (${changeLabel(target)}) can move to (${page.timezone}):\n${slotLines(slots, page)}\nOffer up to 3 (day + time), ask which works, and when the ${person} picks one emit [[reschedule booking="${target.ref}" start="…"]] with that slot's exact start value.`,
      offered: {
        slots,
        hostUid: target.booking.assignedToUid,
        page,
        keys: slots.map((s) => rescheduleOfferKey(target.booking.eventId, s.startAt.toISOString())),
        moveEventId: target.booking.eventId,
      },
    };
  } catch (err) {
    console.error(
      `[booking-tools] move slots failed sa=${subAccountId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      toolResult: `${prefix} Couldn't load availability right now. Apologise and offer to have the team follow up.`,
    };
  }
}

function noNewBookings(audience: BookingAudience): BookingToolOutcome {
  return {
    toolResult: `${TOOL_PREFIX[audience]} New bookings can't be made in this conversation. Share the booking link instead (or offer to have the team follow up).`,
  };
}

async function isCurrentMoveSlot(
  input: RunBookingToolInput,
  target: ChangeTarget,
  startAtIso: string,
): Promise<boolean> {
  if (!startAtIso || Number.isNaN(new Date(startAtIso).getTime())) return false;
  const iso = normalizeIso(startAtIso);
  const slots = await input.engine
    .listRescheduleSlots(input.subAccountId, target.booking.page, {
      id: target.booking.eventId,
      assignedToUid: target.booking.assignedToUid,
    })
    .catch((err: unknown) => {
      console.warn(
        `[booking-tools] move re-check failed sa=${input.subAccountId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [] as SlotCandidate[];
    });
  return slots.some((s) => s.startAt.toISOString() === iso);
}

async function rescheduleFailure(
  input: RunBookingToolInput,
  target: ChangeTarget,
  result: Exclude<ChangeToolResult, { ok: true }>,
): Promise<BookingToolOutcome> {
  const prefix = TOOL_PREFIX[input.audience];
  const person = who(input.audience);
  if (result.code === "limit") {
    return {
      toolResult: `${prefix} Not changed: this conversation has made the maximum number of changes for today. Tell the ${person} the team will follow up.`,
    };
  }
  if (result.code === "bad_state") {
    return { toolResult: `${prefix} Couldn't move it: ${result.message} Tell the ${person}.` };
  }
  if (result.code === "error") {
    return {
      toolResult: `${prefix} Moving the appointment failed due to a system error. Apologise and tell the ${person} the team will follow up.`,
    };
  }
  // invalid start or taken: hand back fresh times in one go.
  const fresh = await listMoveSlots(input, target);
  const lead =
    result.code === "slot_taken"
      ? "That time is no longer available. Apologise briefly."
      : "That start value wasn't one of the offered times — copy one EXACTLY from the list.";
  return { ...fresh, toolResult: `${prefix} ${lead}\n${fresh.toolResult.replace(`${prefix} `, "")}` };
}

/** Canonical ISO for set lookups; unparseable input passes through unchanged. */
export function normalizeIso(raw: string): string {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}
