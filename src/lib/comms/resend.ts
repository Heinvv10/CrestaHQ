import "server-only";

import { recordEmailMessage } from "@/lib/server/email-conversations";
import { Resend } from "resend";

import { resolveCustomBrand } from "@/lib/landing/resolve-brand";
import { recordUsage } from "@/lib/server/usage-meter";
import type { SmtpMeta } from "@/types/email";
import { getSmtpConnection, sendSmtpEmail, SmtpError, validEmail } from "./smtp";
import { markProviderAttempted, rethrowAttempted } from "@/lib/comms/provider-attempt";
import { assertNotSuppressed } from "@/lib/comms/email-suppression";
import type { ResendConfig } from "@/types/tenancy";
import { runAfterResponse } from "@/lib/server/after-response";

let _client: Resend | null = null;

export function getResend(): Resend {
  if (!_client) {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      throw new Error(
        "RESEND_API_KEY is not set. Add it to .env.local to enable email."
      );
    }
    _client = new Resend(key);
  }
  return _client;
}

export interface EmailAccount {
  emailProvider?: "resend" | "smtp";
  smtpConfig?: SmtpMeta | null;
  replyToEmail?: string | null;
}

export function emailIsConfigured(sub?: EmailAccount | null): boolean {
  if (sub?.emailProvider === "smtp") {
    return !!(
      sub.smtpConfig?.verifiedAt &&
      sub.smtpConfig.host &&
      sub.smtpConfig.fromEmail
    );
  }
  // `.trim()` so a present-but-blank env var doesn't read as configured.
  return (
    !!process.env.RESEND_API_KEY?.trim() && !!process.env.EMAIL_FROM?.trim()
  );
}

/**
 * Resolves the From address for a sub-account under the platform-managed
 * sending model. Returns the tenant's dedicated sending-domain address only
 * when BOTH the agency-controlled gate is on AND the domain is verified;
 * otherwise undefined, so `sendEmail` falls back to the shared EMAIL_FROM.
 * The double check is deliberate: if an agency flips the gate off while a
 * verified resendConfig is still on the doc, runtime sending immediately
 * reverts to shared without waiting for the cleanup write.
 *
 * Pass the result straight into `sendEmail({ ..., from })`.
 */
export function tenantFrom(
  sub?: {
    resendConfig?: ResendConfig | null;
    emailDomainEnabledByAgency?: boolean;
  } | null
): string | undefined {
  if (sub?.emailDomainEnabledByAgency !== true) return undefined;
  const cfg = sub.resendConfig;
  return cfg && cfg.status === "verified" ? cfg.emailFrom : undefined;
}

/**
 * Last-resort Reply-To: the deployment's support address (agency doc
 * `supportEmail`, falling back to CUSTOM_BRAND.supportEmail). Without a
 * derived Reply-To, replies go to the `From` address — on a typical
 * deployment a send-only domain with no MX, so they bounce into nothing.
 * Cached per instance for 10 minutes; resolution failures degrade to
 * undefined (the old behavior) rather than blocking the send.
 */
let _replyToCache: { value: string | undefined; at: number } | null = null;
async function defaultReplyTo(): Promise<string | undefined> {
  const now = Date.now();
  if (_replyToCache && now - _replyToCache.at < 10 * 60 * 1000) {
    return _replyToCache.value;
  }
  let value: string | undefined;
  try {
    const brand = await resolveCustomBrand();
    value = brand.supportEmail?.trim() || undefined;
  } catch {
    value = undefined;
  }
  _replyToCache = { value, at: now };
  return value;
}

export async function sendEmail({
  to,
  subject,
  text,
  html,
  replyTo,
  from,
  subAccount,
  attachments,
  meter,
  smtpSubAccountId,
  suppressionSubAccountId,
  archive = true,
  contactId,
  sentByUid,
  inReplyTo,
  references,
}: {
  /** False for credentials, login links and internal staff notifications. */
  archive?: boolean;
  contactId?: string;
  sentByUid?: string;
  inReplyTo?: string;
  references?: string[];
  to: string;
  subject: string;
  /** Plain-text fallback. Required so clients that don't render HTML still get content. */
  text: string;
  /** Optional rich-text body. Resend uses html when present, text as fallback. */
  html?: string;
  /**
   * Explicit Reply-To — wins when the right address is narrower than the
   * derived default (invites → the inviter, contact sends → the operator).
   * When omitted, derivation is `subAccount.replyToEmail` → the deployment
   * support address, so nothing goes out with a bouncing send-only Reply-To.
   */
  replyTo?: string;
  /**
   * Per-sub-account sender override. When a sub-account has a verified
   * dedicated sending domain, pass its `emailFrom` here (use `tenantFrom`).
   * Omit for platform/transactional sends — falls back to the deployment-wide
   * EMAIL_FROM shared sender.
   */
  from?: string;
  /** Sub-account whose `replyToEmail` should answer replies (see `replyTo`). */
  subAccount?: EmailAccount | null;
  /**
   * Usage Metering v1 — when set, a successful send increments the
   * workspace's monthly `emailsSent` ledger. Passed by customer/workspace
   * send sites only; deployment-level mail (invites, billing links, magic
   * links) is deliberately unmetered — it isn't client spend. Enforcement
   * (blocking) happens at the caller for the few paths that should block;
   * transactional mail (booking confirmations, quotes) is metered here
   * but never refused.
   *
   * The same sub-account's email suppression list is enforced here: a
   * suppressed `to` throws `EmailSuppressedError` before any provider call.
   */
  meter?: { subAccountId: string } | null;
  /**
   * The SMTP mailbox for an UNMETERED send through `subAccount`'s SMTP —
   * platform mail about that sub-account when the deployment has no shared
   * sender (see `platform-email.ts`). Metered sends use `meter.subAccountId`.
   */
  smtpSubAccountId?: string;
  /**
   * Suppression list to check for an UNMETERED send that is still addressed
   * on a sub-account's behalf (member invites). Metered sends are checked
   * against `meter.subAccountId` without it.
   */
  suppressionSubAccountId?: string;
  /**
   * File attachments (e.g. booking ICS). Content is base64 unless it's
   * plain text — matches Resend's `attachments` contract.
   */
  attachments?: { filename: string; content: string; contentType?: string }[];
}): Promise<{
  id: string;
  /** "resend" when Resend accepted it: `id` is a Resend email id, which its events webhook reports. */
  provider?: "resend";
  saved?: boolean;
  warning?: string;
}> {
  // A bare address only: "Name <x@y>" would hash differently from x@y and
  // slip past the suppression lookup.
  if (!validEmail(to)) throw new SmtpError("Invalid recipient email address.");
  // Agency billing, gitpage and usage mail name no sub-account and have no
  // suppression list to check.
  const suppressionScope = suppressionSubAccountId ?? meter?.subAccountId;
  if (suppressionScope) await assertNotSuppressed(suppressionScope, to);
  const preferredReplyTo = replyTo?.trim() || subAccount?.replyToEmail?.trim();
  if (subAccount?.emailProvider === "smtp") {
    const smtpId = meter?.subAccountId ?? smtpSubAccountId;
    if (!smtpId) {
      throw new Error("SMTP sending requires an explicit sub-account.");
    }
    const connection = await getSmtpConnection(smtpId);
    const result = await sendSmtpEmail(connection, {
      to,
      subject,
      text,
      html,
      replyTo: preferredReplyTo || connection.fromEmail,
      attachments,
      inReplyTo,
      references,
      archive,
    });
    if (meter?.subAccountId) {
      runAfterResponse(() => recordUsage({
        subAccountId: meter.subAccountId,
        unit: "emailsSent",
        qty: 1,
      }));
    }
    if (!archive) return result;
    try {
      await recordEmailMessage({
        subAccountId: smtpId,
        contactId,
        sentByUid,
        direction: "outbound",
        subject,
        body: text,
        from: connection.fromEmail,
        to: [to],
        messageId: result.id,
        inReplyTo,
        references,
        attachments: attachments?.map((a) => ({
          filename: a.filename,
          contentType: a.contentType ?? "application/octet-stream",
          size: Buffer.from(a.content, "base64").length,
        })),
        occurredAt: new Date(),
        historical: false,
      });
      return { ...result, saved: true };
    } catch {
      // SMTP acceptance is irreversible. Returning success prevents callers/queues retrying delivery.
      console.warn(
        "[email/send] SMTP accepted; conversation persistence failed",
        { subAccountId: smtpId, messageId: result.id }
      );
      return {
        ...result,
        saved: false,
        warning:
          "Email was sent, but could not be saved to Conversations. Do not resend. Contact your administrator.",
      };
    }
  }
  const resolvedFrom = from ?? process.env.EMAIL_FROM;
  if (!resolvedFrom) {
    throw new Error(
      "EMAIL_FROM is not set. It must be a sender on a Resend-verified domain."
    );
  }
  const client = getResend();
  const result = await client.emails.send({
    from: resolvedFrom,
    to,
    subject,
    text,
    ...(html ? { html } : {}),
    replyTo: preferredReplyTo || (await defaultReplyTo()),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  }).catch(rethrowAttempted);
  if (result.error) {
    throw markProviderAttempted(new Error(result.error.message || "Resend send failed"));
  }
  if (!result.data?.id) {
    throw markProviderAttempted(new Error("Resend send failed: no message id returned"));
  }
  if (meter?.subAccountId) {
    runAfterResponse(() => recordUsage({
      subAccountId: meter.subAccountId,
      unit: "emailsSent",
      qty: 1,
    }));
  }
  return { id: result.data.id, provider: "resend" };
}

/**
 * Sends the SAME plain-text email to many recipients as INDIVIDUAL emails
 * (each recipient's own To: line — no CC/BCC leakage) via Resend's batch API,
 * which takes up to 100 messages per call. Used by the agency "Email
 * purchasers" tool. Best-effort per chunk: a failed batch counts its whole
 * chunk as failed and keeps going, so one bad chunk never aborts the rest.
 */
export async function sendPlainTextBroadcast({
  recipients,
  subject,
  text,
  from,
  replyTo,
}: {
  recipients: string[];
  subject: string;
  text: string;
  from?: string;
  replyTo?: string;
}): Promise<{ sent: number; failed: number; errors: string[] }> {
  const resolvedFrom = from ?? process.env.EMAIL_FROM;
  if (!resolvedFrom) {
    throw new Error(
      "EMAIL_FROM is not set. It must be a sender on a Resend-verified domain."
    );
  }
  const client = getResend();
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < recipients.length; i += 100) {
    const chunk = recipients.slice(i, i + 100);
    try {
      const res = await client.batch.send(
        chunk.map((to) => ({
          from: resolvedFrom,
          to,
          subject,
          text,
          ...(replyTo ? { replyTo } : {}),
        }))
      );
      if (res.error) {
        failed += chunk.length;
        errors.push(res.error.message ?? "Resend batch error");
      } else {
        sent += chunk.length;
      }
    } catch (err) {
      failed += chunk.length;
      errors.push(err instanceof Error ? err.message : "Unknown batch error");
    }
  }

  return { sent, failed, errors: errors.slice(0, 5) };
}
