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
 *
 * Through a sub-account's SMTP, Reply-To would default to that client's own
 * mailbox; platform mail is the agency's, so replies go to the agency's
 * `supportEmail`, else its owner's email (unchanged when it has neither).
 */
export type PlatformSender =
  | { kind: "shared" }
  | { kind: "smtp"; subAccountId: string; sub: EmailAccount & { agencyId?: string } };

export async function resolvePlatformSender(
  subAccountId: string | null | undefined,
): Promise<PlatformSender | null> {
  if (emailIsConfigured()) return { kind: "shared" };
  if (!subAccountId) return null;
  const sub = (await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data() as
    | (EmailAccount & { agencyId?: string })
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
export async function sendPlatformEmail(
  sender: PlatformSender,
  email: PlatformEmail,
): ReturnType<typeof sendEmail> {
  if (sender.kind === "shared") return sendEmail(email);
  return sendEmail({
    ...email,
    replyTo: email.replyTo || (await agencyContactEmail(sender.sub.agencyId)),
    subAccount: sender.sub,
    smtpSubAccountId: sender.subAccountId,
    archive: false,
  });
}

async function agencyContactEmail(agencyId: string | undefined): Promise<string | undefined> {
  if (!agencyId) return undefined;
  const db = getAdminDb();
  const agency = (await db.doc(`agencies/${agencyId}`).get()).data() ?? {};
  const support = typeof agency.supportEmail === "string" ? agency.supportEmail.trim() : "";
  if (support) return support;
  if (typeof agency.ownerUid !== "string" || !agency.ownerUid) return undefined;
  const owner = (await db.doc(`users/${agency.ownerUid}`).get()).data()?.email;
  return typeof owner === "string" && owner.trim() ? owner.trim() : undefined;
}

/**
 * Logs the missing sender, with the detail, as an error server-side and
 * returns a generic Error whose message is safe to show a user.
 */
export function noPlatformSender(tag: string, subAccountId: string | null | undefined): Error {
  console.error(
    `${tag} no email sender: the shared sender (RESEND_API_KEY/EMAIL_FROM) is not set and ${
      subAccountId ? `sub-account ${subAccountId} has no verified SMTP` : "there is no sub-account to send from"
    }. Email not sent.`,
  );
  return new Error("No email could be sent — configure SMTP in Settings.");
}
