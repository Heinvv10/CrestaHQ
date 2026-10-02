import "server-only";

import { getAdminAuth } from "@/lib/firebase/admin";
import { resolveCustomBrand } from "@/lib/landing/resolve-brand";
import { platformSmtpConnection } from "@/lib/comms/platform-smtp";
import { sendSmtpEmail } from "@/lib/comms/smtp";
import { renderSystemEmail } from "@/lib/comms/system-email";

/**
 * Sends the password-reset mail ourselves instead of through Firebase.
 *
 * Firebase's mail links to <project>.firebaseapp.com, which spam filters
 * score as phishing (URI_FIREBASEAPP), and the project refuses changes to
 * that link (EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED). So: ask Firebase for the
 * one-time code, point it at our own /login (which completes the reset —
 * see reset-password-form.tsx) and send it from the deployment's mailbox.
 *
 * "fallback" means this deployment has no platform mailbox or app URL; the
 * client then uses Firebase's own mail, so buyer copies keep working.
 * "skipped" (no such account, or disabled) is reported to the caller exactly
 * like "sent", so the form never reveals whether an account exists.
 */
export type ResetOutcome = "sent" | "skipped" | "fallback" | "limited";

const WINDOW_MS = 60 * 60 * 1000;
// 20, not lower: the production smoke run makes two requests per run from one
// runner IP, and several runs can land in an hour.
const PER_IP_LIMIT = 20;
const PER_EMAIL_LIMIT = 5;
const MAX_TRACKED = 5_000;

const ipHits = new Map<string, number[]>();
const emailHits = new Map<string, number[]>();

/** In-memory, resets on restart — a mail-bomb dampener, not a security boundary. */
function overLimit(map: Map<string, number[]>, key: string, limit: number): boolean {
  const now = Date.now();
  if (map.size > MAX_TRACKED) map.clear();
  const recent = (map.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= limit) {
    map.set(key, recent);
    return true;
  }
  recent.push(now);
  map.set(key, recent);
  return false;
}

export async function requestPasswordReset(
  email: string,
  ip: string,
): Promise<ResetOutcome> {
  if (overLimit(ipHits, ip, PER_IP_LIMIT)) return "limited";
  if (overLimit(emailHits, email, PER_EMAIL_LIMIT)) return "limited";

  // Never derived from the request's Host header: a forged Host would
  // otherwise put an attacker's domain in front of a real reset code.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  const brand = await resolveCustomBrand();
  const connection = platformSmtpConnection(brand.name);
  if (!appUrl || !connection) return "fallback";

  const auth = getAdminAuth();
  try {
    const user = await auth.getUserByEmail(email);
    if (user.disabled) return "skipped";
  } catch (err) {
    if ((err as { code?: string }).code === "auth/user-not-found") return "skipped";
    throw err;
  }

  const firebaseLink = await auth.generatePasswordResetLink(email);
  const code = new URL(firebaseLink).searchParams.get("oobCode");
  if (!code) throw new Error("Firebase reset link carried no oobCode.");
  const url = `${appUrl}/login?mode=resetPassword&oobCode=${encodeURIComponent(code)}`;

  const { html, text } = renderSystemEmail({
    brand,
    preview: "Use the link inside to choose a new password. It expires in 1 hour.",
    heading: "Reset your password",
    paragraphs: [
      `We got a request to reset the password for **${email}**.`,
      "Click the button below to choose a new one.",
    ],
    button: { label: "Choose a new password", url },
    note: "This link works once and expires in 1 hour. If you didn't ask for this, ignore this email — your password won't change.",
  });
  await sendSmtpEmail(connection, {
    to: email,
    subject: `Reset your ${brand.name} password`,
    text,
    html,
    replyTo: brand.supportEmail?.trim() || undefined,
  });
  return "sent";
}
