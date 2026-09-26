import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { stableReviewKey } from "@/lib/gbp/auto-reply-never";
import { gbpProviderMode } from "@/lib/gbp/provider/mode";
import { pushIsConfigured } from "@/lib/push/config";
import { sendPushForEvent } from "@/lib/push/send";
import { reviewsAiMode } from "../ai/mode";

/**
 * Review auto-reply alerts (AUTO_REPLY_V1_PLAN.md "Alerts", PR 4), through
 * the WhatsApp quality alerts' rail: a push to the sub-account and an email
 * to the agency owner. Each alert is first recorded as a server-only doc in
 * `subAccounts/{id}/reviewAutoReplyAlerts` with `create()`; an id that
 * exists means it was already sent, so nothing is sent again:
 *
 *   held               `held-{runId}`         one per engine run that put ≥1 review in front of a person
 *   edited_low         `edited-{reviewKey}`   one per review, ever (the id survives a cache clear)
 *   reconnect_required auto id                the writer's false→true flip is the dedupe (auto-reply on only)
 *   listing_changed    auto id                the writer's on→off switch is the dedupe
 *
 * Review content never leaves beyond the star and the first 80 characters
 * of the text (edited_low); the doc holds none. In fake mode (CI and dev on
 * the production Firestore) the doc is written and nothing is delivered.
 * Delivery is AT MOST ONCE and not awaited: once the doc exists, the push
 * and the email go out in the background (an SMTP stall must not hold a sync
 * lease or a user's request), and a failed send is logged, not retried —
 * the same contract as the WhatsApp quality alert.
 * Never throws: an alert must not fail the sync, the run or the route.
 */

export type AutoReplyAlert =
  | { kind: "held"; runId: string; count: number }
  | { kind: "edited_low"; reviewName: string; reviewDocId: string; star: number; comment: string | null }
  | { kind: "reconnect_required" }
  | { kind: "listing_changed" };

export const autoReplyAlertsCollection = (sa: string) => `subAccounts/${sa}/reviewAutoReplyAlerts`;

export const EXCERPT_CHARS = 80;

/** The first 80 characters of a review's text, whitespace collapsed. */
export function excerpt(text: string | null): string | null {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  return chars.length > EXCERPT_CHARS ? `${chars.slice(0, EXCERPT_CHARS).join("").trimEnd()}…` : flat;
}

const kindOf = (err: unknown) => (err instanceof Error ? err.name : typeof err);

function delivering(): boolean {
  try {
    return gbpProviderMode() !== "fake" && reviewsAiMode() !== "fake";
  } catch {
    return false; // a misconfigured fake: still not a real deployment
  }
}

export async function sendAutoReplyAlert(sa: string, alert: AutoReplyAlert, now = new Date()): Promise<void> {
  try {
    const db = getAdminDb();
    const sub = (await db.doc(`subAccounts/${sa}`).get()).data();
    if (!sub || typeof sub.agencyId !== "string") return;
    const col = db.collection(autoReplyAlertsCollection(sa));
    const ref =
      alert.kind === "held" ? col.doc(`held-${alert.runId}`)
      : alert.kind === "edited_low" ? col.doc(`edited-${stableReviewKey(alert.reviewName)}`)
      : col.doc();
    try {
      await ref.create({
        agencyId: sub.agencyId,
        subAccountId: sa,
        createdByUid: "system",
        kind: alert.kind,
        createdAt: now,
        ...(alert.kind === "held" ? { count: alert.count } : {}),
        ...(alert.kind === "edited_low" ? { star: alert.star, reviewDocId: alert.reviewDocId } : {}),
      });
    } catch (err) {
      if ((err as { code?: unknown })?.code === 6) return; // ALREADY_EXISTS: already sent
      throw err;
    }
    if (!delivering()) {
      console.warn(`[reputation/auto-reply] fake or misconfigured provider mode: alert ${alert.kind} not delivered sa=${sa}`);
      return;
    }
    const msg = message(sa, alert);
    if (!pushIsConfigured()) console.warn(`[reputation/auto-reply] push not configured, alert not delivered sa=${sa}`);
    void sendPushForEvent({
      subAccountId: sa, agencyId: sub.agencyId, title: msg.title, body: msg.body, url: msg.url,
      // Per review for edited_low, so a second edited review does not replace the first on the device.
      tag: alert.kind === "edited_low" ? `auto-reply-edited-${alert.reviewDocId}` : `auto-reply-${alert.kind}-${sa}`,
    });
    void emailOwner(sa, sub, msg);
  } catch (err) {
    console.warn(`[reputation/auto-reply] alert ${alert.kind} failed sa=${sa} kind=${kindOf(err)}`);
  }
}

interface Message {
  title: string;
  body: string;
  url: string;
  /** The email's first paragraph. */
  detail: string;
}

function message(sa: string, alert: AutoReplyAlert): Message {
  const reviews = `/sa/${sa}/reputation/reviews`;
  switch (alert.kind) {
    case "held": {
      const n = alert.count === 1 ? "1 Google review" : `${alert.count} Google reviews`;
      return {
        title: "Reviews wait for approval",
        body: `${n} need approval before a reply is posted`,
        url: reviews,
        detail: `Review auto-reply held ${n} for approval. Open Reputation → Reviews and use the "Needs approval" filter to post or discard each draft.`,
      };
    }
    case "edited_low": {
      const text = excerpt(alert.comment);
      return {
        title: `An auto-replied review changed to ${alert.star}★`,
        body: text ? `“${text}”` : "No written text",
        url: reviews,
        detail: `A Google review that was replied to automatically was edited to ${alert.star}★. Check that the reply still fits.${text ? `\n\n“${text}”` : ""}`,
      };
    }
    case "reconnect_required":
      return {
        title: "Google needs reconnecting",
        body: "Reviews stopped syncing and auto-reply is paused",
        // Sent only while auto-reply is on (tokens.ts), so "paused" is true.
        url: `/sa/${sa}/reputation`,
        detail: "Google refused this sub-account's Business Profile connection. Reviews stop syncing and review auto-reply cannot post until an admin reconnects Google.",
      };
    case "listing_changed":
      return {
        title: "Review auto-reply switched off",
        body: "The Google listing changed — re-enable to resume",
        url: `/sa/${sa}/reputation/settings`,
        detail: "The selected Google listing changed, so review auto-reply was switched off. Re-enable it in Reputation → Settings to resume.",
      };
  }
}

async function emailOwner(sa: string, sub: Record<string, unknown>, msg: Message): Promise<void> {
  try {
    // Dynamic: resend.ts pulls in the conversation and usage services, and
    // the token and sync writers that call this sit underneath those.
    const mail = await import("@/lib/comms/resend");
    if (!mail.emailIsConfigured(sub)) {
      console.warn(`[reputation/auto-reply] email not configured, alert not delivered sa=${sa}`);
      return;
    }
    const db = getAdminDb();
    const agency = (await db.doc(`agencies/${sub.agencyId as string}`).get()).data() ?? {};
    let to: string | null = null;
    if (typeof agency.ownerUid === "string" && agency.ownerUid) {
      to = ((await db.doc(`users/${agency.ownerUid}`).get()).data()?.email as string | undefined) ?? null;
    }
    to = to ?? (agency.supportEmail as string | undefined) ?? null;
    if (!to) {
      console.warn(`[reputation/auto-reply] no owner email, alert not emailed sa=${sa}`);
      return;
    }
    const wsName = String(sub.name || sa).replace(/[\r\n]+/g, " ");
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
    await mail.sendEmail({
      to,
      subject: `${wsName}: ${msg.title}`,
      text: [msg.detail, "", `Open: ${appUrl}${msg.url}`].join("\n"),
      subAccount: sub as Parameters<typeof mail.sendEmail>[0]["subAccount"],
      meter: { subAccountId: sa },
      // Internal staff notification — not a customer conversation.
      archive: false,
    });
  } catch (err) {
    console.warn(`[reputation/auto-reply] alert email failed sa=${sa} kind=${kindOf(err)}`);
  }
}
