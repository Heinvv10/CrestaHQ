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

/** A WhatsApp template as sent: its body with the values filled in, and its button URLs. */
export function templateParts(
  tpl: { body?: string | null; buttons?: ReadonlyArray<{ type: string; url?: string }> | null },
  values: readonly string[],
): string[] {
  const body = (tpl.body ?? "").replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => values[Number(n) - 1] ?? "");
  return [body, ...(tpl.buttons ?? []).flatMap((b) => (b.type === "url" && b.url ? [b.url] : []))];
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
  createdByUid: string;
  outcome: AskOutcome;
}

/** Log the send when it is a review ask. Never throws. */
export async function logIfReviewAsk(a: ReviewAskSend): Promise<void> {
  if (!isReviewAsk(resolveReviewUrl(a.sub).configured, a.parts, a.template)) return;
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

/** A conversation-send outcome as a log outcome. */
export function askOutcomeOf(outcome: SendOutcome): AskOutcome {
  if (outcome.ok) return { ok: true, messageSid: outcome.messageId };
  const kind =
    outcome.code ??
    (outcome.outcomeUnknown ? "outcome_unknown" : outcome.status === 429 ? "quota" : outcome.status >= 500 ? "send_failed" : "refused");
  return { ok: false, failureKind: kind };
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
  actorUid: string;
  outcome: AskOutcome;
}): Promise<void> {
  if (a.channel !== "sms" && a.channel !== "whatsapp" && a.channel !== "email") return;
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
      createdByUid: a.actorUid,
      outcome: a.outcome,
    });
  } catch (err) {
    const kind = (err as { code?: unknown })?.code ?? (err as Error)?.name ?? "unknown";
    console.warn(`[reviews/review-ask] inbox review-ask check failed kind=${String(kind)}`);
  }
}
