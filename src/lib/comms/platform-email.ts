import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, type EmailAccount } from "./resend";

/**
 * Who sends platform mail — invites, billing links, usage alerts — that is
 * ABOUT one sub-account but is not that workspace's own customer send.
 *
 * The deployment's shared sender (Resend) when it is configured. Otherwise
 * the verified SMTP of the sub-account the mail concerns, and only that one:
 * one tenant's mail never goes out through another tenant's mailbox, so mail
 * with no sub-account, or whose sub-account has no SMTP, has no sender.
 *
 * Callers report a null through `noPlatformSender`; never a silent skip.
 */
export type PlatformSender =
  | { kind: "shared" }
  | { kind: "smtp"; subAccountId: string; sub: EmailAccount };

export async function resolvePlatformSender(
  subAccountId: string | null | undefined,
): Promise<PlatformSender | null> {
  if (emailIsConfigured()) return { kind: "shared" };
  if (!subAccountId) return null;
  const sub = (await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data() as
    | EmailAccount
    | undefined;
  if (sub?.emailProvider !== "smtp" || !emailIsConfigured(sub)) return null;
  return { kind: "smtp", subAccountId, sub };
}

type PlatformEmail = Omit<
  Parameters<typeof sendEmail>[0],
  "subAccount" | "meter" | "smtpSubAccountId" | "from" | "archive"
>;

/**
 * Sends through the resolved sender. Unmetered (platform mail is not client
 * spend) and never archived into the sub-account's Conversations.
 */
export function sendPlatformEmail(
  sender: PlatformSender,
  email: PlatformEmail,
): ReturnType<typeof sendEmail> {
  if (sender.kind === "shared") return sendEmail(email);
  return sendEmail({
    ...email,
    subAccount: sender.sub,
    smtpSubAccountId: sender.subAccountId,
    archive: false,
  });
}

/** Logs the missing sender as an error and returns it, for callers that surface it. */
export function noPlatformSender(tag: string, subAccountId: string | null | undefined): Error {
  const err = new Error(
    `No email sender: the shared sender (RESEND_API_KEY/EMAIL_FROM) is not set and ${
      subAccountId ? `sub-account ${subAccountId} has no verified SMTP` : "there is no sub-account to send from"
    }. Email not sent.`,
  );
  console.error(`${tag} ${err.message}`);
  return err;
}
