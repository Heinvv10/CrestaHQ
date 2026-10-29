import "server-only";

import type { SlotCandidate } from "@/lib/booking/availability";
import { emailIsConfigured, type EmailAccount } from "@/lib/comms/resend";
import { validEmail } from "@/lib/comms/smtp";
import {
  formatSlotForSpeech,
  type AgentBookingEngine,
  type AgentBookingLocation,
  type AgentBookResult,
} from "@/lib/comms/ai/booking-engine";
import {
  attr,
  bookOfferKey,
  findMarker,
  MAX_SCAN_CHARS,
  parseMarkerAttrs,
  parseStartIso,
  rescheduleOfferKey,
  type MarkerAttrs,
} from "@/lib/comms/ai/booking-markers";
import {
  bookMarkerExample,
  changeLabel,
  hostSelectionOn,
  invalidHostResult,
  resolveRequestedHost,
  TOOL_PREFIX,
  who,
  type BookingAudience,
  type ChangeTarget,
} from "@/lib/comms/ai/booking-prompt";
import type { BookingPage, IntakeField } from "@/types/booking";

/**
 * Live booking "tools" for agents that run in custom-LLM style (phone voice,
 * website chat and voice, SMS/WhatsApp/Messenger). We are the LLM, so tools
 * are markers the model emits and we intercept before the reply is shown or
 * spoken: run the real service, feed the result back as a labelled message,
 * and let the model phrase the reply. The prompt that teaches the markers is
 * booking-prompt.ts; their syntax is booking-markers.ts.
 *
 *   [[slots host="…"]]                                 open times for a new booking
 *   [[book start="…" name="…" email="…" phone="…" host="…" q1="…"]]   book one
 *   [[slots booking="b1"]]                             times to move booking b1 to
 *   [[reschedule booking="b1" start="…"]]              move it
 *   [[cancel booking="b1"]]                            cancel it
 *
 * book, reschedule and cancel run only when the reply is that one marker and
 * nothing else; a reply with prose around one is prose, and the marker is
 * stripped. Callers must strip leftovers (stripBookingMarkers) before the
 * text reaches a person; a marker can survive when the tool-round cap is hit.
 *
 * The engine (slots, reschedule slots) is passed in as `engine`, and the
 * page's location as `location`, so this module has no Firestore access.
 */

function isPlausiblePhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

/** What a [[book]] marker asked for, after identity and intake checks. */
export interface BookRequest {
  /** Canonical ISO instant; the one the offered-times gate checked. */
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
  const emailOk = validEmail(req.email);
  const phoneOk = isPlausiblePhone(req.phone);
  if (audience === "web-text") {
    if (req.name && emailOk) return null;
    return `${prefix} Not booked yet — you need the visitor's name and a valid email address first.${req.email && !emailOk ? ` "${req.email.slice(0, 200)}" isn't a valid email address.` : ""} Ask for whatever is missing, then emit ${example} again.`;
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

/** Answers keyed q1..qN in page order, validated like the public booking route. */
function parseIntake(
  attrs: MarkerAttrs,
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
  /** `startAtIso` is the canonical instant the gate checked. */
  reschedule?: (target: ChangeTarget, startAtIso: string) => Promise<ChangeToolResult>;
  /** Offered-time keys that may be used. Null = any valid slot (phone only). */
  allowedKeys: ReadonlySet<string> | null;
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

  const bookMatch = findMarker(modelText, "book");
  const rescheduleMatch = findMarker(modelText, "reschedule");
  const cancelMatch = findMarker(modelText, "cancel");
  // An action marker mixed with prose is prose: the caller strips it.
  if ([bookMatch, rescheduleMatch, cancelMatch].some((m) => m && !m.whole)) return null;

  const duplicateAttrs = (): BookingToolOutcome => ({
    toolResult: `${prefix} That marker repeated an attribute, so nothing was done. Emit it again with each attribute exactly once.`,
  });

  if (bookMatch) {
    const attrs = parseMarkerAttrs(bookMatch.attrs);
    if (!attrs) return duplicateAttrs();
    return input.page ? runBook(input, input.page, attrs) : noNewBookings(audience);
  }

  const changeable = input.changeable ?? [];
  const findTarget = (attrs: MarkerAttrs): ChangeTarget | null => {
    const ref = attr(attrs, "booking").toLowerCase();
    return changeable.find((t) => t.ref === ref) ?? null;
  };
  const unknownTarget = (): BookingToolOutcome => ({
    toolResult: changeable.length
      ? `${prefix} That booking reference isn't one of this ${person}'s upcoming appointments. Use one of: ${changeable.map((t) => `${t.ref} (${changeLabel(t)})`).join("; ")}.`
      : `${prefix} There are no upcoming appointments you can change in this conversation. Offer the reschedule/cancel link from their confirmation email, or have the team follow up.`,
  });

  if (rescheduleMatch && input.reschedule) {
    const attrs = parseMarkerAttrs(rescheduleMatch.attrs);
    if (!attrs) return duplicateAttrs();
    const target = findTarget(attrs);
    if (!target) return unknownTarget();
    const startAtIso = parseStartIso(attr(attrs, "start"));
    // Without stored offers (phone: its history only carries speech) the start
    // must still be one of the times the booking can move to right now, so a
    // rebuilt or shifted timestamp re-lists instead of moving the wrong slot.
    const allowed =
      startAtIso !== null &&
      (input.allowedKeys
        ? input.allowedKeys.has(rescheduleOfferKey(target.booking.eventId, startAtIso))
        : await isCurrentMoveSlot(input, target, startAtIso));
    if (startAtIso === null || !allowed) {
      return rescheduleFailure(input, target, { ok: false, code: "invalid" });
    }
    const result = await input.reschedule(target, startAtIso).catch((err: unknown) => {
      console.error(
        `[booking-tools] reschedule failed sa=${subAccountId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false, code: "error" } as const;
    });
    if (result.ok) {
      const label = formatSlotForSpeech(new Date(startAtIso), target.booking.page.timezone);
      return {
        toolResult: `${prefix} Moved: ${target.booking.page.name} is now ${label}. Confirm it to the ${person} briefly${audience === "phone" ? "" : " and mention an updated confirmation is on its way if they have an email on file"}.`,
        changed: { kind: "rescheduled", eventId: target.booking.eventId, label },
      };
    }
    return rescheduleFailure(input, target, result);
  }

  if (cancelMatch && input.cancel) {
    const attrs = parseMarkerAttrs(cancelMatch.attrs);
    if (!attrs) return duplicateAttrs();
    const target = findTarget(attrs);
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

  const slotsMatch = findMarker(modelText, "slots");
  if (slotsMatch) {
    const attrs = parseMarkerAttrs(slotsMatch.attrs);
    if (!attrs) return duplicateAttrs();
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
  attrs: MarkerAttrs,
): Promise<BookingToolOutcome> {
  const { audience, subAccountId } = input;
  const prefix = TOOL_PREFIX[audience];
  const person = who(audience);
  const intake = input.intake ?? [];
  const rawStart = attr(attrs, "start");
  const name = attr(attrs, "name").slice(0, 120);
  const email = attr(attrs, "email").toLowerCase();
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
  if (!rawStart) {
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

  // Unparseable is refused here; everything after sees the canonical instant only.
  const startAtIso = parseStartIso(rawStart);
  try {
    let result: BookToolResult = { ok: false, code: "invalid_slot" };
    if (startAtIso !== null) {
      const req: BookRequest = {
        startAtIso,
        name,
        email: validEmail(email) ? email : null,
        phone: phone && isPlausiblePhone(phone) ? phone : null,
        hostUid,
        intakeAnswers: parsedIntake.answers,
        address: address || null,
      };
      // A replay check that can't run fails closed (the error branch below):
      // booking anyway could double-book a provider retry on another host.
      const existing = input.findExisting ? await input.findExisting(req) : null;
      const offeredOk =
        !input.allowedKeys ||
        input.allowedKeys.has(bookOfferKey(page.slug, hostUid, startAtIso));
      if (existing) result = existing;
      else if (offeredOk) result = await input.book(req);
    }
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
          : validEmail(email)
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
            keys: alternatives.map((s) =>
              bookOfferKey(page.slug, hostUid, s.startAt.toISOString()),
            ),
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
  attrs: MarkerAttrs,
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
        keys: slots.map((s) => bookOfferKey(page.slug, hostUid, s.startAt.toISOString())),
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

/** `iso` is already canonical (parseStartIso). */
async function isCurrentMoveSlot(
  input: RunBookingToolInput,
  target: ChangeTarget,
  iso: string,
): Promise<boolean> {
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
