import "server-only";

import { NextResponse } from "next/server";
import { vapiWebhookAuthorized } from "@/lib/comms/voice/webhook-auth";
import { getAdminDb } from "@/lib/firebase/admin";
import { callAi, type AiChatMessage } from "@/lib/comms/ai/openrouter";
import { incrementChannelTokens, resolveAgent } from "@/lib/comms/ai/agent";
import { buildContactContextBlock } from "@/lib/comms/ai/context";
import { buildSystemPrompt } from "@/lib/comms/ai/prompt";
import {
  bookVoiceSlot,
  formatSlotForSpeech,
  getVoiceBookingContext,
  listVoiceSlots,
} from "@/lib/server/voice-booking-service";
import { hostSelectionEnabled } from "@/lib/booking/page-slots";
import type { BookingHost, BookingPage } from "@/types/booking";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Vapi custom-LLM webhook. Vapi POSTs this endpoint on every voice
 * turn with an OpenAI-compatible chat-completion request body — we
 * respond with an OpenAI-shaped completion that Vapi reads aloud.
 *
 * Vapi quirk: it dumb-string-concatenates `/chat/completions` to the
 * registered model.url. The resulting HTTP request *path* stays at
 * `/api/webhooks/vapi/llm/[subAccountId]` (this file's location);
 * the `/chat/completions` ends up tacked onto the query string. To
 * keep our `?s=` secret param clean, we register the URL with a
 * trailing `&_=` so Vapi appends `/chat/completions` to the `_=`
 * sink instead of corrupting `s=`. See vapi.ts buildAssistantBody().
 *
 * This route is the one and only choke-point where voice replies are
 * generated, so it MUST go through the same `resolveAgent()` +
 * `buildSystemPrompt()` + `callAi()` pipeline SMS and Web Chat use.
 * That's how the persona / KB / business hours / escalation rules
 * stay consistent across channels. We deliberately IGNORE the system
 * prompt Vapi composes — its contents are not what the operator
 * configured.
 *
 * Security: the webhook secret travels as a `?s=…` query param baked
 * into the URL we registered with Vapi at provisioning time. Custom-
 * LLM has no native auth mechanism so a URL secret is the simplest
 * shape that survives Vapi's path-append behavior.
 *
 * Response shape: non-streaming OpenAI completion in v1. Haiku 4.5
 * latency is sub-1s which keeps the perceived turn-around tight.
 * Streaming SSE can be added later if latency becomes the bottleneck.
 */

interface VapiLlmBody {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  /** Vapi defaults to true for voice (low-latency streaming). When
   *  true we return SSE; when explicitly false we return single JSON. */
  stream?: boolean;
  /** Vapi's per-call context. The customer phone is what we use to
   *  look up an existing Contact for context injection. */
  call?: {
    id?: string;
    customer?: { number?: string };
    phoneNumber?: { number?: string };
    /** Metadata we stamp via assistantOverrides on outbound calls (see
     *  createOutboundCall). Vapi echoes it back on every turn so we can
     *  pick the outbound persona. */
    metadata?: { direction?: string; contactId?: string };
  };
}

function badRequest(message: string, status: number): NextResponse {
  return NextResponse.json({ error: { message } }, { status });
}

async function findContactByPhone(
  subAccountId: string,
  phone: string,
): Promise<Contact | null> {
  const snap = await getAdminDb()
    .collection("contacts")
    .where("subAccountId", "==", subAccountId)
    .where("phone", "==", phone)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...(doc.data() as Omit<Contact, "id">) };
}

function openAiCompletion(text: string, model: string): unknown {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

/**
 * Strip anything the model might emit that would be embarrassing read
 * aloud: leftover [[capture …]] / [[form …]] markers, stray markdown
 * asterisks, bracket fragments. The voice safety rails forbid these
 * but prompt drift happens; this is the last line of defense before
 * the TTS engine pronounces "bracket bracket capture name equals"
 * verbatim on a real call.
 */
function stripVoiceUnspeakables(text: string): string {
  return (
    text
      // Whole [[anything]] blocks — capture markers, form markers, etc.
      .replace(/\[\[[^\]]*\]\]/g, "")
      // Stray opening/closing brackets the regex above might miss
      // if the model emitted an unclosed marker.
      .replace(/\[\[/g, "")
      .replace(/\]\]/g, "")
      // Markdown asterisks (TTS would say "asterisk asterisk").
      .replace(/\*\*/g, "")
      .replace(/(?<!\w)\*(?!\w)/g, "")
      // Collapse runs of whitespace the strips may have created.
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Stream the reply as OpenAI-format SSE chunks. Vapi expects this
 * shape for custom-LLM (it's the OpenAI streaming chat-completion
 * format). We don't have a token-level stream from OpenRouter here,
 * so we emit the full text as a single content chunk followed by a
 * stop chunk and the [DONE] sentinel. Voice latency is dominated by
 * the upstream LLM call anyway, so single-chunk streaming has the
 * same perceived latency as token streaming would for these short
 * voice replies.
 */
function openAiSseStream(text: string, model: string): Response {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  const body =
    chunk({ role: "assistant", content: text }, null) +
    chunk({}, "stop") +
    "data: [DONE]\n\n";

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string }> },
) {
  if (!vapiWebhookAuthorized(request)) {
    // Make the #1 cause of "custom-llm 500" visible: the ?s= secret on the
    // assistant URL doesn't match this server's VAPI_WEBHOOK_SECRET (stale
    // secret baked in at provision time, or the assistant points at a
    // different deployment). Fix: re-save Voice settings to re-PATCH the
    // assistant with the current URL + secret.
    const provided = new URL(request.url).searchParams.get("s");
    const expected = process.env.VAPI_WEBHOOK_SECRET?.trim();
    console.warn(
      `[vapi/llm] 401 — webhook secret mismatch. providedSecret=${
        provided ? "present" : "MISSING"
      } serverSecretConfigured=${expected ? "yes" : "NO"} ` +
        `match=${provided?.trim() === expected}. ` +
        `Re-save Voice settings to re-point the assistant.`,
    );
    return badRequest("Unauthorized", 401);
  }

  const { subAccountId } = await ctx.params;

  let body: VapiLlmBody;
  try {
    body = (await request.json()) as VapiLlmBody;
  } catch {
    return badRequest("Invalid JSON body", 400);
  }

  // Everything below is wrapped so ANY unexpected throw degrades to a
  // graceful spoken fallback (HTTP 200) instead of a hard 500 that drops
  // the live call. The real error is logged for debugging. Legit auth /
  // config short-circuits below still `return` their own status codes.
  const wantsStream = body.stream !== false;
  try {
  const agent = await resolveAgent(subAccountId, "voice");
  if (!agent) {
    return badRequest("Voice channel not configured for this sub-account", 404);
  }
  if (!agent.effective.enabled) {
    return badRequest("Voice channel is disabled for this sub-account", 403);
  }
  if (!agent.effective.systemPrompt.trim()) {
    return badRequest("Voice channel has no persona configured", 503);
  }

  const saSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!saSnap.exists) return badRequest("Sub-account not found", 404);
  const subAccount = saSnap.data() as SubAccountDoc;

  // Agency gate (defense-in-depth). Enabling the Voice channel is already
  // gated at the channels route, but disabling the agency gate does NOT tear
  // down an already-provisioned Vapi assistant — so re-check per turn and
  // refuse if the agency has since locked it. Inbound and outbound read
  // their respective gates.
  const isOutboundCall = body.call?.metadata?.direction === "outbound";
  // Inbound Voice defaults ON (opt-out) — undefined reads as enabled, only an
  // explicit `false` locks. Outbound stays opt-IN (`=== true`).
  const voiceGateOn = isOutboundCall
    ? subAccount.outboundVoiceEnabledByAgency === true
    : subAccount.inboundVoiceEnabledByAgency !== false;
  if (!voiceGateOn) {
    return badRequest(
      `${isOutboundCall ? "Outbound" : "Inbound"} voice is disabled for this sub-account by the agency`,
      403,
    );
  }

  const callerPhone = body.call?.customer?.number?.trim() ?? "";
  const contact = callerPhone
    ? await findContactByPhone(subAccountId, callerPhone).catch(() => null)
    : null;

  const contextBlock = contact
    ? await buildContactContextBlock(contact).catch(() => null)
    : null;

  // Outbound calls run a different persona than inbound (the AI is calling
  // the contact about an offer, not answering a query). We stamp
  // direction:"outbound" into the call metadata at createOutboundCall; when
  // present AND an outbound persona is configured, swap it in. Falls back to
  // the shared persona when blank or for inbound calls.
  const outboundPersona = agent.channel.voice?.outboundSystemPrompt?.trim();
  const personaOverride =
    isOutboundCall && outboundPersona ? outboundPersona : null;

  let systemPrompt = buildSystemPrompt({
    agent,
    channelId: "voice",
    fallbackBusinessName: subAccount.name ?? "the business",
    contactContextBlock: contextBlock,
    personaOverride,
    bookingLink: subAccount.bookingLink ?? null,
  });

  // ── Voice Booking v1 — live booking tools (inbound calls only) ──────
  // When the voice channel designates a bookable page, append the marker
  // instructions and run a tool loop around the LLM call below. Anything
  // unbookable (missing/unpublished/deposit page) silently degrades to
  // the plain booking-link behavior — a page edit can't break live calls.
  let bookingPage: BookingPage | null = null;
  if (!isOutboundCall) {
    const slugCfg = agent.channel.voice?.bookingPageSlug ?? null;
    if (slugCfg) {
      const bctx = await getVoiceBookingContext(subAccountId, slugCfg).catch(
        () => null,
      );
      if (bctx?.bookable) {
        bookingPage = bctx.page;
        systemPrompt += `\n\n${buildBookingToolsBlock(bctx.page)}`;
      } else if (bctx) {
        console.warn(
          `[vapi/llm] booking page "${slugCfg}" not bookable (${bctx.reason}) sa=${subAccountId} — falling back to link behavior`,
        );
      }
    }
  }

  // Strip Vapi's own system message — the persona we want is the one
  // we just composed. Keep the user / assistant turn history as-is.
  const turns: AiChatMessage[] = (body.messages ?? [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: typeof m.content === "string" ? m.content : "",
    }))
    .filter((m) => m.content.length > 0);

  const messages: AiChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...turns,
  ];

  // Vapi defaults to stream:true for custom-LLM (low-latency voice).
  // (wantsStream is computed above so the outer catch can reuse it.)

  try {
    // Tool loop: up to 2 booking-tool rounds on top of the initial call.
    // Without a booking page (or when the model emits no marker) this is
    // exactly one LLM call — identical to the pre-booking behavior.
    let totalTokens = 0;
    let speakText = "";
    let modelUsed = "";
    for (let round = 0; round < 3; round++) {
      const completion = await callAi({
        model: agent.effective.modelOverride ?? body.model ?? undefined,
        messages,
        // Voice replies should be short — cap aggressively to avoid the
        // bot launching into a paragraph that the caller will interrupt.
        maxTokens: 220,
        temperature: 0.5,
      });
      totalTokens += completion.totalTokens;
      modelUsed = completion.model;
      speakText = completion.text;

      const toolResult =
        bookingPage && round < 2
          ? await runBookingToolIfRequested({
              modelText: completion.text,
              subAccountId,
              agencyId: subAccount.agencyId,
              page: bookingPage,
              callerPhone,
              callerEmail: contact?.email ?? null,
              contactId: contact?.id ?? null,
              callId: body.call?.id ?? null,
            })
          : null;
      if (!toolResult) break;
      // Feed the tool result back and let the model compose the spoken
      // reply. Clearly labelled so it can't be mistaken for the caller.
      messages.push(
        { role: "assistant", content: completion.text },
        { role: "user", content: toolResult },
      );
    }

    void incrementChannelTokens(subAccountId, "voice", totalTokens);

    // Defensive: strip any [[...]] markers, leftover JSON-ish brackets,
    // or asterisks from the reply before TTS speaks it. Voice safety
    // rails forbid these but model output drifts; on voice the TTS
    // engine reads symbols out loud character-by-character which sounds
    // terrible. Web Chat / SMS keep their marker parsing untouched —
    // this is voice-only sanitisation. Also the last line of defense if
    // the tool loop exhausted its rounds with a marker still in the text.
    const speakable =
      stripVoiceUnspeakables(speakText) ||
      "Sorry, could you say that again?";

    return wantsStream
      ? openAiSseStream(speakable, modelUsed)
      : NextResponse.json(openAiCompletion(speakable, modelUsed));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `[vapi/llm] LLM call failed sa=${subAccountId}: ${msg}`,
    );
    // Return a graceful spoken fallback. Status 200 so Vapi doesn't
    // play its own error message (which sounds worse than our text).
    const fallbackText =
      "Sorry, I'm having trouble hearing you. Could you say that again?";
    const fallbackModel = agent.effective.modelOverride ?? "fallback";
    return wantsStream
      ? openAiSseStream(fallbackText, fallbackModel)
      : NextResponse.json(openAiCompletion(fallbackText, fallbackModel));
  }
  } catch (outerErr) {
    // Unexpected throw OUTSIDE the LLM call (resolveAgent, Firestore read,
    // prompt build, etc.). Log the full error + stack so the root cause is
    // visible in the server logs, and degrade gracefully so the live call
    // doesn't drop with a provider-fault 500.
    console.error(
      `[vapi/llm] UNHANDLED error sa=${subAccountId} —`,
      outerErr,
    );
    const fallbackText =
      "Sorry, I'm having a bit of trouble right now. Could you say that again?";
    return wantsStream
      ? openAiSseStream(fallbackText, "fallback")
      : NextResponse.json(openAiCompletion(fallbackText, "fallback"));
  }
}

// ── Voice Booking v1 — marker tools ─────────────────────────────────────
// We ARE the LLM in Vapi's custom-llm mode, so "tools" are simply markers
// the model emits that we intercept BEFORE anything reaches TTS: run the
// real availability/book service, feed the result back as a labelled
// message, and let the model compose the spoken reply. No Vapi tool
// registration, no extra webhook route, and existing assistants pick this
// up without re-provisioning. stripVoiceUnspeakables() guarantees a marker
// can never be spoken even if the loop cap is hit.

const SLOTS_MARKER_RE = /\[\[\s*slots\b([^\]]*)\]\]/i;
const BOOK_MARKER_RE = /\[\[\s*book\b([^\]]*)\]\]/i;

/** Phrases the caller might use for "no preference" — treated as pooled
 *  (first-available), never a host name to resolve. */
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

function parseHostAttr(attrs: string): string {
  return /host\s*=\s*"([^"]*)"/i.exec(attrs)?.[1]?.trim() ?? "";
}

/**
 * Resolve a spoken host name to a page host, case-insensitively: exact
 * display-name match first, then a UNIQUE "starts with" match (so "Jane"
 * resolves "Jane Smith"). Ambiguous or unknown ⇒ null. Never throws.
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
 * Resolve a requested host from a marker's attrs. Returns the uid to book/
 * narrow against (null = pooled / anyone), plus an `invalid` flag when a
 * name was given but doesn't resolve — the caller treats that as its own
 * distinct outcome (NOT a scheduling conflict), mirroring how a bad
 * slot-copy is kept separate from a real conflict.
 */
function resolveRequestedHost(
  page: BookingPage,
  attrs: string,
): { hostUid: string | null; invalid: boolean } {
  const spoken = parseHostAttr(attrs);
  if (!spoken) return { hostUid: null, invalid: false };
  if (ANY_HOST_PHRASES.has(spoken.toLowerCase())) {
    return { hostUid: null, invalid: false };
  }
  const host = resolveHostByName(page, spoken);
  return host
    ? { hostUid: host.uid, invalid: false }
    : { hostUid: null, invalid: true };
}

function invalidHostResult(page: BookingPage): string {
  const names = (page.hosts ?? []).map((h) => h.name).join(", ");
  return `[SYSTEM TOOL RESULT — not the caller speaking] That name isn't one of our team members — this is NOT a scheduling conflict and NOT a booking error. Our team members are: ${names}. Ask the caller which of them they'd like (or offer "anyone available"), then re-emit the marker with host="<exact name>" — or omit host for anyone.`;
}

/** True when this page exposes named-host selection to the caller. */
function hostSelectionOn(page: BookingPage): boolean {
  return hostSelectionEnabled(page);
}

function buildBookingToolsBlock(page: BookingPage): string {
  const hostBlock = hostSelectionOn(page)
    ? `
HOST SELECTION: This business lets the caller book with a specific team member. Our team: ${(page.hosts ?? []).map((h) => h.name).join(", ")}. EARLY in the booking — before offering times — ask the caller which team member they'd like, or whether anyone available is fine. Pass their choice as host="<team member's name>" in BOTH markers: [[slots host="<name>"]] and [[book start="…" name="…" host="<name>"]]. If the caller has no preference, OMIT the host attribute (or use host="anyone") and the system picks the least-busy person. Only offer the times the system returns for the chosen person.`
    : "";
  return `--- LIVE BOOKING TOOLS ---
You can book real appointments for the caller on the business's "${page.name}" calendar (${page.durationMinutes}-minute slots, times in ${page.timezone}). This SUPERSEDES the earlier booking guidance: book directly during this call instead of promising a texted link — only fall back to the link if no offered time suits the caller.
Markers (the system intercepts them; the caller never hears them):
1. When the caller wants to book, schedule, or pick a time, respond with EXACTLY [[slots]] and nothing else. The system hands you the available times.
2. Offer AT MOST 3 of those times conversationally (day + time, e.g. "Tuesday at ten a.m."). Ask which works.
3. When the caller chooses a time AND you know their first name (ask for it first if you don't), respond with EXACTLY [[book start="<the exact start value of the chosen slot>" name="<caller's first name>"]] and nothing else.
4. The system reports the result; confirm to the caller in one short sentence.${hostBlock}
Rules: never invent or confirm a time that didn't come from [[slots]]. COPY the start value character-for-character from the [[slots]] result — never retype, reformat, shorten, or reconstruct a timestamp from the day/time you spoke aloud. Never read raw start values or dates in ISO format aloud. If the system says a time was just taken, apologise and offer the alternatives it provides.`;
}

/**
 * If the model's text contains a booking marker, execute it and return the
 * tool-result message to feed back; null when no marker (the text is the
 * final spoken reply). Failures return an instructive tool result rather
 * than throwing — a booking hiccup must never drop the live call.
 */
/**
 * Mark on the voiceCalls doc that the caller engaged the booking flow, so
 * the end-of-call handler can create a "call back" Task when the call ends
 * WITHOUT a completed booking (a caller busy booking never triggers Vapi's
 * `callbackRequested`). Separate field from the `booked` stamp so a merge
 * can't clobber a success. Best-effort — a failure just means no task.
 */
async function stampBookingAttempt(
  subAccountId: string,
  callId: string | null,
): Promise<void> {
  if (!callId) return;
  try {
    await getAdminDb()
      .doc(`subAccounts/${subAccountId}/voiceCalls/${callId}`)
      .set(
        { voiceBooking: { attemptedAt: new Date().toISOString() } },
        { merge: true },
      );
  } catch (err) {
    console.warn(`[vapi/llm] booking-attempt stamp failed sa=${subAccountId}`, err);
  }
}

async function runBookingToolIfRequested(input: {
  modelText: string;
  subAccountId: string;
  agencyId: string;
  page: BookingPage;
  callerPhone: string;
  callerEmail: string | null;
  contactId: string | null;
  callId: string | null;
}): Promise<string | null> {
  const { modelText, subAccountId, agencyId, page } = input;
  const allowHostSelection = hostSelectionOn(page);

  const bookMatch = BOOK_MARKER_RE.exec(modelText);
  if (bookMatch) {
    const attrs = bookMatch[1] ?? "";
    const startAtIso = /start\s*=\s*"([^"]+)"/.exec(attrs)?.[1]?.trim() ?? "";
    const callerName = /name\s*=\s*"([^"]*)"/.exec(attrs)?.[1]?.trim() ?? "";
    // Resolve the requested host first — an unrecognised name is its own
    // outcome, not a name/slot problem.
    let hostUid: string | null = null;
    if (allowHostSelection) {
      const r = resolveRequestedHost(page, attrs);
      if (r.invalid) {
        void stampBookingAttempt(subAccountId, input.callId);
        return invalidHostResult(page);
      }
      hostUid = r.hostUid;
    }
    if (!callerName) {
      return "[SYSTEM TOOL RESULT — not the caller speaking] You must know the caller's first name before booking. Ask for their name, then emit the [[book …]] marker again with it.";
    }
    if (!startAtIso) {
      return "[SYSTEM TOOL RESULT — not the caller speaking] The book marker was missing its start value. Emit [[slots]] to get fresh times, then book with the exact start value of the slot the caller chose.";
    }
    try {
      const result = await bookVoiceSlot({
        subAccountId,
        agencyId,
        page,
        startAtIso,
        callerName,
        callerPhone: input.callerPhone,
        callerEmail: input.callerEmail,
        contactId: input.contactId,
        hostUid,
        callId: input.callId,
      });
      if (result.ok) {
        const label = formatSlotForSpeech(result.startAt, page.timezone);
        return `[SYSTEM TOOL RESULT — not the caller speaking] Booked: ${label} (${page.durationMinutes} minutes). Confirm briefly to the caller — day and time only — and let them know it's locked in.`;
      }
      // The caller tried to book but it didn't complete — record the
      // attempt so the end-of-call handler follows up if the call ends
      // without a booking.
      void stampBookingAttempt(subAccountId, input.callId);
      // Not booked. Include fresh alternatives in the same result so
      // recovery doesn't cost another tool round. Distinguish the reasons:
      // an `invalid_slot` is almost always the model reconstructing the
      // timestamp instead of copying the exact start="…" value — telling it
      // "no longer available" (a real-conflict message) would send it into
      // a retry loop on the same bad value. Give it a copy-exactly nudge
      // instead. A genuine `slot_taken` gets the apologise-and-offer path.
      const alternatives = await listVoiceSlots(
        subAccountId,
        page,
        hostUid,
      ).catch(() => []);
      const altLines = alternatives
        .map(
          (s) =>
            `- start="${s.startAt.toISOString()}" → ${formatSlotForSpeech(s.startAt, page.timezone)}`,
        )
        .join("\n");
      if (result.code === "invalid_slot") {
        return `[SYSTEM TOOL RESULT — not the caller speaking] That start value wasn't a valid slot time — do NOT retype or reconstruct timestamps. Re-emit [[book]] using a start value COPIED EXACTLY (character-for-character) from the list below.${
          altLines
            ? `\n${altLines}`
            : " No times are currently loaded — emit [[slots]] first, then copy a start value from that result verbatim."
        }`;
      }
      if (result.code === "error") {
        return "[SYSTEM TOOL RESULT — not the caller speaking] Booking failed due to a system error. Apologise and tell the caller the team will follow up to lock in a time.";
      }
      return `[SYSTEM TOOL RESULT — not the caller speaking] That time is no longer available. Apologise briefly.${
        altLines
          ? ` Offer up to 3 of these instead:\n${altLines}`
          : " Nothing else is open in the next 7 days — offer to have the team follow up with times by text."
      }`;
    } catch (err) {
      console.error(
        `[vapi/llm] book tool failed sa=${subAccountId} slug=${page.slug}`,
        err,
      );
      return "[SYSTEM TOOL RESULT — not the caller speaking] Booking failed due to a system error. Apologise and tell the caller the team will follow up to lock in a time.";
    }
  }

  const slotsMatch = SLOTS_MARKER_RE.exec(modelText);
  if (slotsMatch) {
    const attrs = slotsMatch[1] ?? "";
    let hostUid: string | null = null;
    if (allowHostSelection) {
      const r = resolveRequestedHost(page, attrs);
      if (r.invalid) {
        void stampBookingAttempt(subAccountId, input.callId);
        return invalidHostResult(page);
      }
      hostUid = r.hostUid;
    }
    // The caller wants to see times — that's booking intent. Record it so a
    // call that ends before a booking still creates a follow-up Task.
    void stampBookingAttempt(subAccountId, input.callId);
    try {
      const slots = await listVoiceSlots(subAccountId, input.page, hostUid);
      const forHost = hostUid
        ? ` for ${(page.hosts ?? []).find((h) => h.uid === hostUid)?.name ?? "the chosen host"}`
        : "";
      if (slots.length === 0) {
        return `[SYSTEM TOOL RESULT — not the caller speaking] No available times${forHost} in the next 7 days. Tell the caller nothing's open this week${hostUid ? " with that person (offer another team member or anyone available)" : ""} and offer to have the team follow up (or text the booking link).`;
      }
      const lines = slots
        .map(
          (s) =>
            `- start="${s.startAt.toISOString()}" → ${formatSlotForSpeech(s.startAt, page.timezone)}`,
        )
        .join("\n");
      return `[SYSTEM TOOL RESULT — not the caller speaking] Available times${forHost} (${page.timezone}):\n${lines}\nOffer AT MOST 3 conversationally (day + time), ask which works, and when the caller picks one — and you have their first name — emit [[book start="…" name="…"${hostUid ? ' host="…"' : ""}]] with that slot's exact start value.`;
    } catch (err) {
      console.error(
        `[vapi/llm] slots tool failed sa=${subAccountId} slug=${page.slug}`,
        err,
      );
      return "[SYSTEM TOOL RESULT — not the caller speaking] Couldn't load availability right now. Apologise and offer to have the team follow up with times.";
    }
  }

  return null;
}
