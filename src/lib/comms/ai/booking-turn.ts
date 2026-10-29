import "server-only";

import {
  callAi,
  type AiChatMessage,
  type CallAiOptions,
} from "@/lib/comms/ai/openrouter";
import {
  runBookingTool,
  type BookingToolOutcome,
  type RunBookingToolInput,
} from "@/lib/comms/ai/booking-tools";
import {
  bookOfferKey,
  normalizeIso,
  promptSafe,
  rescheduleOfferKey,
  stripBookingMarkers,
} from "@/lib/comms/ai/booking-markers";
import type { ChangeTarget } from "@/lib/comms/ai/booking-prompt";
import {
  formatSlotForChip,
  formatSlotForSpeech,
} from "@/lib/comms/ai/booking-engine";
import type { SlotCandidate } from "@/lib/booking/availability";
import type { BookingPage } from "@/types/booking";
import type { WebChatBookingOffer } from "@/types/web-chat";

/**
 * One reply turn with live booking tools: the LLM call plus up to two tool
 * rounds, shared by the phone agent, the website widget and the messaging
 * channels. Channel code supplies the handlers (who the contact is, caps,
 * where offers are stored); this file owns the loop and the prompt state.
 */

/** Two tool rounds after the first LLM call. */
const MAX_TOOL_ROUNDS = 2;
/** Offered times older than this aren't replayed or usable; the bot lists fresh ones. */
const OFFER_TTL_MS = 2 * 60 * 60 * 1000;

/** Times offered in a conversation, persisted between turns (web session or conversation doc). */
export type StoredBookingOffer = WebChatBookingOffer;

/**
 * The stored offer when it's fresh enough to replay, else null. An offer
 * stamped in the future is not fresh: it would never expire.
 */
export function liveOffer(
  offer: StoredBookingOffer | null | undefined,
): StoredBookingOffer | null {
  if (!offer || !offer.pageSlug || !Array.isArray(offer.slots) || offer.slots.length === 0) {
    return null;
  }
  const age = Date.now() - offer.offeredAtMs;
  return age >= 0 && age <= OFFER_TTL_MS ? offer : null;
}

/** Keys a later marker may use, from a stored offer; none once it's stale. */
export function offerKeys(stored: StoredBookingOffer | null): string[] {
  const offer = liveOffer(stored);
  if (!offer?.pageSlug) return [];
  const pageSlug = offer.pageSlug;
  return offer.slots.map((s) =>
    offer.moveEventId
      ? rescheduleOfferKey(offer.moveEventId, s.startIso)
      : bookOfferKey(pageSlug, offer.hostUid, s.startIso),
  );
}

/** The "--- BOOKING STATE ---" section: what's booked, what's known, what's on offer. */
export function buildBookingStateBlock(input: {
  /** Labels of upcoming bookings made in this conversation. */
  bookedLabels: string[];
  /** The conversation's booking cap is used up. */
  limitReached: boolean;
  known: { name?: string | null; email?: string | null; phone?: string | null };
  confirmKnown: boolean;
  offer: StoredBookingOffer | null;
  /** Page whose hosts name the offer's host. */
  offerPage: BookingPage | null;
  changeable: ChangeTarget[];
  /** A time button the visitor tapped (already matched against the offer). */
  picked: { startIso: string; label: string } | null;
}): string {
  const state: string[] = [];
  if (input.bookedLabels.length > 0) {
    state.push(
      `Already booked in this conversation: ${input.bookedLabels.join("; ")}. Only book again if they clearly ask for another appointment.`,
    );
  }
  if (input.limitReached) {
    state.push(
      "This conversation has reached its booking limit: do NOT make a new booking; the team will help with anything further.",
    );
  }
  const known = (
    [
      ["name", input.known.name],
      ["email", input.known.email],
      ["phone", input.known.phone],
    ] as const
  )
    .map(([k, v]) => [k, promptSafe(v)] as const)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k} "${v}"`);
  if (known.length > 0) {
    state.push(
      `Details already on file: ${known.join(", ")}. Use them in the [[book]] marker instead of asking again${input.confirmKnown ? " (confirm them once)" : ""}.`,
    );
  }
  const offer = liveOffer(input.offer);
  if (offer) {
    const moveRef = offer.moveEventId
      ? input.changeable.find((t) => t.booking.eventId === offer.moveEventId)?.ref ?? null
      : null;
    const hostName = offer.hostUid && !offer.moveEventId
      ? (input.offerPage?.hosts ?? []).find((h) => h.uid === offer.hostUid)?.name ?? null
      : null;
    const purpose = offer.moveEventId
      ? moveRef
        ? `Times offered for moving ${moveRef} (use [[reschedule booking="${moveRef}" start="…"]])`
        : null
      : `Times already offered for a new booking${hostName ? ` with ${hostName} (include host="${hostName}" when booking one)` : ""}`;
    if (purpose) {
      state.push(
        `${purpose} — copy a start value exactly:\n${offer.slots
          .map((s) => `- start="${s.startIso}" → ${s.label}`)
          .join("\n")}`,
      );
    }
  }
  const pickedMoveRef =
    input.picked && offer?.moveEventId
      ? input.changeable.find((t) => t.booking.eventId === offer.moveEventId)?.ref ?? null
      : null;
  if (input.picked && pickedMoveRef) {
    state.push(
      `They just tapped the time start="${input.picked.startIso}" (${input.picked.label}) to move ${pickedMoveRef}. Emit [[reschedule booking="${pickedMoveRef}" start="${input.picked.startIso}"]] now.`,
    );
  } else if (input.picked && offer?.moveEventId) {
    state.push(
      `They just tapped ${input.picked.label} to move a booking that can no longer be changed here. Do NOT make a new booking for it; tell them and offer to look at fresh times.`,
    );
  } else if (input.picked) {
    state.push(
      `They just tapped the time start="${input.picked.startIso}" (${input.picked.label})${
        offer?.hostUid
          ? (() => {
              const name = (input.offerPage?.hosts ?? []).find((h) => h.uid === offer.hostUid)?.name;
              return name ? ` with ${name} (include host="${name}")` : "";
            })()
          : ""
      }. If you already have every detail needed, emit the [[book]] marker for it now. Otherwise ask for what's missing and book it once they reply.`,
    );
  }
  return state.length > 0 ? `--- BOOKING STATE ---\n${state.join("\n")}` : "";
}

/** Find a tapped/picked time in the stored offer (new booking or a move). */
export function matchPickedSlot(
  offer: StoredBookingOffer | null,
  pickedIso: string | null,
): { startIso: string; label: string } | null {
  const live = liveOffer(offer);
  if (!live || !pickedIso) return null;
  const iso = normalizeIso(pickedIso);
  return live.slots.find((s) => s.startIso === iso) ?? null;
}

export function toStoredOffer(
  offered: NonNullable<BookingToolOutcome["offered"]>,
  labelStyle: "chip" | "speech",
): StoredBookingOffer {
  const fmt = labelStyle === "chip" ? formatSlotForChip : formatSlotForSpeech;
  return {
    pageSlug: offered.page.slug,
    slots: offered.slots.map((s) => ({
      startIso: s.startAt.toISOString(),
      label: fmt(s.startAt, offered.page.timezone),
    })),
    hostUid: offered.hostUid,
    offeredAtMs: Date.now(),
    moveEventId: offered.moveEventId ?? null,
  };
}

export interface BookingTurnResult {
  text: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  model: string;
  /** Label of a booking made this turn. */
  bookedLabel: string | null;
  /** A cancel or reschedule happened this turn. */
  changed: boolean;
  /** Last times offered this turn and still current (nothing booked or moved after). */
  lastOffer: NonNullable<BookingToolOutcome["offered"]> | null;
}

/**
 * Throws only if the first LLM call fails (the caller shows its fallback).
 * A failure after an action landed still confirms the action. After a booking
 * or change, the turn runs no further tools: the next call only phrases it.
 */
export async function callAiWithBookingTools(input: {
  messages: AiChatMessage[];
  /** Model, caps and model fallback; token accounting is the caller's (see the totals returned). */
  ai: Omit<CallAiOptions, "messages">;
  /** Null = booking off: exactly one plain LLM call. */
  tools: Omit<RunBookingToolInput, "modelText" | "allowedKeys"> | null;
  /** Offered-time keys usable this turn; grows as times are offered. Null = no gate. */
  allowedKeys: Set<string> | null;
  /** For logs. */
  subAccountId: string;
  onBooked?: (booked: NonNullable<BookingToolOutcome["booked"]>) => Promise<void>;
  /** Reply when tools ran and the model left nothing to say. Empty = let the caller decide. */
  emptyReplyFallback?: string;
}): Promise<BookingTurnResult> {
  const messages = [...input.messages];
  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let model = "";
  let text = "";
  let bookedLabel: string | null = null;
  let actionLabel: string | null = null;
  let changed = false;
  let lastOffer: BookingTurnResult["lastOffer"] = null;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let completion;
    try {
      completion = await callAi({ ...input.ai, messages });
    } catch (err) {
      if (round === 0) throw err;
      // The model call after a tool round failed. Don't leave a bare marker;
      // say what actually happened.
      console.warn(
        `[booking-turn] follow-up LLM call failed sa=${input.subAccountId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      text = actionLabel ?? "Sorry, I couldn't finish that just now. Could you try again?";
      break;
    }
    totalTokens += completion.totalTokens;
    promptTokens += completion.promptTokens;
    completionTokens += completion.completionTokens;
    model = completion.model;
    text = completion.text;

    if (!input.tools || round === MAX_TOOL_ROUNDS || actionLabel) break;
    const outcome = await runBookingTool({
      ...input.tools,
      modelText: completion.text,
      allowedKeys: input.allowedKeys,
    });
    if (!outcome) break;

    if (outcome.offered) {
      lastOffer = outcome.offered;
      for (const k of outcome.offered.keys) input.allowedKeys?.add(k);
    }
    if (outcome.booked) {
      bookedLabel = outcome.booked.label;
      actionLabel = `You're booked for ${outcome.booked.label}.`;
      lastOffer = null;
      await input.onBooked?.(outcome.booked).catch((err: unknown) =>
        console.warn(
          `[booking-turn] onBooked failed sa=${input.subAccountId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    if (outcome.changed) {
      changed = true;
      actionLabel =
        outcome.changed.kind === "cancelled"
          ? `Your appointment (${outcome.changed.label}) is cancelled.`
          : `Your appointment is now ${outcome.changed.label}.`;
      lastOffer = null;
    }
    // Labelled so it can't be mistaken for the person.
    messages.push(
      { role: "assistant", content: completion.text },
      { role: "user", content: outcome.toolResult },
    );
  }

  // A marker can survive when the round cap is hit; never show it.
  let finalText = stripBookingMarkers(text)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Also when booking is off but the reply was only a marker: never send nothing.
  // Zero-width characters alone count as nothing (they stay in a real reply:
  // U+200D joins emoji).
  if (!finalText.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim() && (input.tools || text.trim())) {
    finalText =
      actionLabel ??
      input.emptyReplyFallback ??
      "Sorry, I couldn't check the calendar just now. Could you try again?";
  }

  return {
    text: finalText,
    totalTokens,
    promptTokens,
    completionTokens,
    model,
    bookedLabel,
    changed,
    lastOffer,
  };
}

/** Spread up to `max` slots across days (two per day first), keeping order. */
export function spreadSlots(
  slots: SlotCandidate[],
  timezone: string,
  max: number,
): SlotCandidate[] {
  let dayKey: (d: Date) => string;
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC" });
    dayKey = (d) => fmt.format(d);
  } catch {
    dayKey = (d) => d.toISOString().slice(0, 10);
  }
  const perDay = new Map<string, number>();
  const chosen = new Set<SlotCandidate>();
  for (const s of slots) {
    if (chosen.size >= max) break;
    const k = dayKey(s.startAt);
    const n = perDay.get(k) ?? 0;
    if (n < 2) {
      chosen.add(s);
      perDay.set(k, n + 1);
    }
  }
  for (const s of slots) {
    if (chosen.size >= max) break;
    chosen.add(s);
  }
  return slots.filter((s) => chosen.has(s));
}
