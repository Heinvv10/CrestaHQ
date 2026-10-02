import "server-only";

import type { SmtpConnection } from "@/types/email";

/**
 * The deployment's own SMTP mailbox, for system mail that belongs to no
 * sub-account — today, password resets. Set all of PLATFORM_SMTP_HOST,
 * _PORT (465 = TLS, 587/2525 = STARTTLS), _USER, _PASS and _FROM; with any
 * missing this returns null and callers fall back to their previous path.
 *
 * Passed to `sendSmtpEmail`, which validates it and refuses hosts that
 * resolve to private addresses, same as a sub-account's mailbox.
 */
export function platformSmtpConnection(fromName = ""): SmtpConnection | null {
  const host = process.env.PLATFORM_SMTP_HOST?.trim();
  const port = Number(process.env.PLATFORM_SMTP_PORT?.trim() || "465");
  const username = process.env.PLATFORM_SMTP_USER?.trim();
  const password = process.env.PLATFORM_SMTP_PASS;
  const fromEmail = process.env.PLATFORM_SMTP_FROM?.trim();
  if (!host || !username || !password || !fromEmail) return null;
  return {
    host,
    port,
    secure: port === 465,
    username,
    password,
    fromEmail,
    fromName,
    verifiedAt: "",
  };
}
