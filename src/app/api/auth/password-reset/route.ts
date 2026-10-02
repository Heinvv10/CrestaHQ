import "server-only";

import { after, NextResponse } from "next/server";
import { deliverPasswordReset, gatePasswordReset } from "@/lib/auth/password-reset";
import { clientIpFrom } from "@/lib/checkout/rate-limit";
import { validEmail } from "@/lib/comms/smtp";

/**
 * Public: the login page's "Forgot password?" form posts here. The same
 * reply, in the same time, whether or not the account exists.
 */
export async function POST(request: Request) {
  let email: string;
  try {
    const body = (await request.json()) as { email?: unknown };
    email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!validEmail(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const gate = gatePasswordReset(email, clientIpFrom(request));
  if (gate === "limited") {
    return NextResponse.json(
      { error: "Too many reset requests. Try again in an hour." },
      { status: 429 },
    );
  }
  if (gate === "fallback") return NextResponse.json({ fallback: true });
  if (gate === "quiet") return NextResponse.json({ ok: true });

  // After the response, so the reply time doesn't depend on whether the
  // account exists. A failed send is logged; the user can ask again.
  after(async () => {
    try {
      await deliverPasswordReset(email);
    } catch (err) {
      console.error("[password-reset] send failed", err instanceof Error ? err.message : err);
    }
  });
  return NextResponse.json({ ok: true });
}
