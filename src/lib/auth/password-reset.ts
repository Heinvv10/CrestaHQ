import "server-only";

import { getAdminAuth } from "@/lib/firebase/admin";
import { resolveCustomBrand } from "@/lib/landing/resolve-brand";
import { platformSmtpConnection } from "@/lib/comms/platform-smtp";
import ipaddr from "ipaddr.js";
import { sendSmtpEmail, validEmail } from "@/lib/comms/smtp";
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
 * The request is answered by `gatePasswordReset` alone — limits and
 * config, no account lookup — and `deliverPasswordReset` runs after the
 * response. So a real account and an unknown one get the same reply in the
 * same time, and the form never reveals whether an account exists.
 *
 * "fallback" means this deployment has no platform mailbox or app URL; the
 * client then uses Firebase's own mail, so buyer copies keep working.
 */
export type ResetGate = "deliver" | "quiet" | "fallback" | "limited";

const WINDOW_MS = 60 * 60 * 1000;
// 20, not lower: the production smoke run makes two requests per run from one
// runner IP, and several runs can land in an hour.
const PER_IP_LIMIT = 20;
/** One caller re-asking for one address. Over it: 429, to that caller only. */
const PER_CALLER_EMAIL_LIMIT = 3;
/**
 * One address, whoever asks. Over it the request still answers {ok:true} and
 * simply sends nothing — a 429 here would let anyone lock a user out of
 * resetting, and the user already has the links that were sent.
 */
const PER_EMAIL_LIMIT = 5;
const MAX_TRACKED = 20_000;

const ipHits = new Map<string, number[]>();
const callerEmailHits = new Map<string, number[]>();
const emailHits = new Map<string, number[]>();

/**
 * IPv6 is keyed by its /64: one connection usually owns the whole prefix,
 * so per-address keys would hand a caller billions of fresh budgets.
 */
function ipKey(ip: string): string {
  if (!ipaddr.isValid(ip)) return ip;
  const addr = ipaddr.process(ip);
  return addr.kind() === "ipv6"
    ? addr.toNormalizedString().split(":").slice(0, 4).join(":") + "::/64"
    : addr.toString();
}

/**
 * In-memory, resets on restart — a mail-bomb dampener, not a security
 * boundary. When full, only expired budgets are dropped; if it is still full
 * a NEW key is refused. Dropping live budgets instead would let a flood of
 * junk keys hand a victim's address a fresh budget.
 */
function overLimit(map: Map<string, number[]>, key: string, limit: number): boolean {
  const now = Date.now();
  if (!map.has(key) && map.size >= MAX_TRACKED) {
    for (const [k, hits] of map) {
      if (hits.every((t) => now - t >= WINDOW_MS)) map.delete(k);
    }
    if (map.size >= MAX_TRACKED) return true;
  }
  const recent = (map.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  const over = recent.length >= limit;
  if (!over) recent.push(now);
  map.set(key, recent);
  return over;
}

function appUrl(): string | undefined {
  // Never derived from the request's Host header: a forged Host would
  // otherwise put an attacker's domain in front of a real reset code.
  return process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") || undefined;
}

export function gatePasswordReset(email: string, ip: string): ResetGate {
  const caller = ipKey(ip);
  if (overLimit(ipHits, caller, PER_IP_LIMIT)) return "limited";
  if (overLimit(callerEmailHits, `${caller}|${email}`, PER_CALLER_EMAIL_LIMIT)) {
    return "limited";
  }
  if (!appUrl() || !platformSmtpConnection()) return "fallback";
  if (overLimit(emailHits, email, PER_EMAIL_LIMIT)) return "quiet";
  return "deliver";
}

/** Run only after `gatePasswordReset` said "deliver". */
export async function deliverPasswordReset(
  email: string,
): Promise<"sent" | "skipped"> {
  const resolved = await resolveCustomBrand();
  // Agency settings accept values a mail header can't carry (a newline in
  // the name, "a,b@x" as support address); clean them so one bad setting
  // can't stop every reset.
  const name = resolved.name.replace(/[\x00-\x1f\x7f]+/g, " ").trim() || "LeadStack";
  const support = resolved.supportEmail?.trim();
  const brand = { ...resolved, name, supportEmail: support && validEmail(support) ? support : null };
  const connection = platformSmtpConnection(brand.name);
  const base = appUrl();
  if (!connection || !base) throw new Error("Platform mailbox not configured.");

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
  const url = `${base}/login?mode=resetPassword&oobCode=${encodeURIComponent(code)}`;

  const { html, text } = renderSystemEmail({
    brand,
    preview: "Use the link inside to choose a new password. It expires in 1 hour.",
    heading: "Reset your password",
    paragraphs: [
      ["We got a request to reset the password for ", { bold: email }, "."],
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
    replyTo: brand.supportEmail ?? undefined,
    // The live link must never be imported into Conversations if this
    // mailbox is also a synced sub-account mailbox.
    archive: false,
  });
  return "sent";
}
