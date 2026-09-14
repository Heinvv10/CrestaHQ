import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { getStarterTemplate } from "@/lib/comms/whatsapp/starter-templates";
import { resolveReviewUrl, type ReviewUrlSource } from "@/lib/reviews/canonical-url";
import {
  logReviewRequest,
  type ReviewRequestChannel,
  type ReviewRequestSource,
} from "@/lib/reviews/request-log";
import type { SendOutcome } from "@/lib/server/conversation-send/types";
import type { Contact } from "@/types/contacts";

/**
 * Is this outbound message a review ask? (SP5 d1.) Detected on what is
 * actually sent — the rendered body, subject, template parameters and button
 * URLs — because `{{reviewUrl}}` does not resolve in workflow or broadcast
 * merge tags: a review ask there carries the pasted link. So a message is a
 * review ask when any rendered part contains the sub-account's CONFIGURED
 * review URL, or when it is the gallery's `review_request` WhatsApp template.
 *
 * Callers are the code that initiates a send (workflow executor, broadcast
 * worker, inbox route) — never a transport — so the dispatcher, which logs its
 * own sends, is never counted twice.
 */

const STARTER = getStarterTemplate("review_request");

export interface TemplateIdentity {
  name?: string | null;
  body?: string | null;
  /** Read defensively: a stored template is not trusted to be well-formed. */
  buttons?: unknown;
}

export function isReviewAsk(
  reviewUrl: string | null,
  parts: ReadonlyArray<string | null | undefined>,
  template?: TemplateIdentity | null,
): boolean {
  if (template && (template.name === STARTER?.key || (!!template.body && template.body === STARTER?.body))) {
    return true;
  }
  return !!reviewUrl && parts.some((p) => typeof p === "string" && p.includes(reviewUrl));
}

/**
 * A WhatsApp template as sent: its body with the values filled in, and its
 * button URLs. Skips anything malformed rather than throwing — this runs
 * beside a send and must never break it.
 */
export function templateParts(tpl: { body?: unknown; buttons?: unknown }, values: readonly unknown[]): string[] {
  const vals = Array.isArray(values) ? values : [];
  const body =
    typeof tpl.body === "string"
      ? tpl.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => {
          const v = vals[Number(n) - 1];
          return typeof v === "string" ? v : "";
        })
      : "";
  const urls = Array.isArray(tpl.buttons)
    ? tpl.buttons.flatMap((b: unknown) => {
        const btn = b as { type?: unknown; url?: unknown } | null;
        return btn && typeof btn === "object" && btn.type === "url" && typeof btn.url === "string" && btn.url ? [btn.url] : [];
      })
    : [];
  return [body, ...urls];
}

/** A machine-readable failure kind, never free text (a provider message can quote a phone number). */
export function failureKindOf(raw: string | null | undefined): string {
  return raw && /^[A-Za-z0-9_]{1,48}$/.test(raw) ? raw : "send_failed";
}

export type AskOutcome = { ok: true; messageSid?: string | null } | { ok: false; failureKind: string };

export interface ReviewAskSend {
  sub: ReviewUrlSource | null;
  agencyId: string;
  subAccountId: string;
  contactId: string;
  channel: ReviewRequestChannel;
  source: Exclude<ReviewRequestSource, "dispatcher">;
  parts: ReadonlyArray<string | null | undefined>;
  template?: TemplateIdentity | null;
  /** When a template went out: its values, so its filled body and buttons are checked too. */
  templateValues?: readonly string[];
  createdByUid: string;
  /** null = not a request (refused before any provider was called). */
  outcome: AskOutcome | null;
}

/** Log the send when it is a review ask. Never throws. */
export async function logIfReviewAsk(a: ReviewAskSend): Promise<void> {
  if (!a.outcome) return;
  try {
    const parts = a.template && a.templateValues ? [...a.parts, ...templateParts(a.template, a.templateValues)] : a.parts;
    if (!isReviewAsk(resolveReviewUrl(a.sub).configured, parts, a.template)) return;
  } catch (err) {
    const kind = (err as { code?: unknown })?.code ?? (err as Error)?.name ?? "unknown";
    console.warn(`[reviews/review-ask] review-ask check failed kind=${String(kind)}`);
    return;
  }
  await logReviewRequest({
    agencyId: a.agencyId,
    subAccountId: a.subAccountId,
    contactId: a.contactId,
    channel: a.channel,
    source: a.source,
    createdByUid: a.createdByUid,
    ...(a.outcome.ok
      ? { status: "sent" as const, messageSid: a.outcome.messageSid ?? null }
      : { status: "failed" as const, failureKind: failureKindOf(a.outcome.failureKind) }),
  });
}

/**
 * A conversation-send outcome as a log outcome; null = not a request. A
 * refusal decided before anything was sent (opt-out, no phone, quota, gate,
 * a shut window, a rail's own refusal) is no request; one after a provider
 * attempt is a failed one.
 */
export function askOutcomeOf(outcome: SendOutcome): AskOutcome | null {
  if (outcome.ok) return { ok: true, messageSid: outcome.messageId };
  if (!outcome.attempted) return null;
  return { ok: false, failureKind: outcome.code ?? (outcome.outcomeUnknown ? "outcome_unknown" : "send_failed") };
}

/**
 * An inbox send (a person in Conversations, or their scheduled message).
 * Reads the sub-account for its configured review URL; Messenger and
 * Instagram are not review-request channels and are ignored.
 */
export async function logInboxReviewAsk(a: {
  contact: Contact;
  channel: string;
  parts: ReadonlyArray<string | null | undefined>;
  template?: TemplateIdentity | null;
  templateValues?: readonly string[];
  actorUid: string;
  outcome: AskOutcome | null;
}): Promise<void> {
  const outcome = a.outcome;
  if (!outcome || (a.channel !== "sms" && a.channel !== "whatsapp" && a.channel !== "email")) return;
  try {
    const sub = (await getAdminDb().doc(`subAccounts/${a.contact.subAccountId}`).get()).data() ?? null;
    await logIfReviewAsk({
      sub: sub as ReviewUrlSource | null,
      agencyId: a.contact.agencyId,
      subAccountId: a.contact.subAccountId,
      contactId: a.contact.id,
      channel: a.channel,
      source: "inbox",
      parts: a.parts,
      template: a.template,
      templateValues: a.templateValues,
      createdByUid: a.actorUid,
      outcome,
    });
  } catch (err) {
    const kind = (err as { code?: unknown })?.code ?? (err as Error)?.name ?? "unknown";
    console.warn(`[reviews/review-ask] inbox review-ask check failed kind=${String(kind)}`);
  }
}
