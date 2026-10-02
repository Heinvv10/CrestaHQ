import "server-only";

import { NextResponse } from "next/server";
import { requestPasswordReset } from "@/lib/auth/password-reset";
import { clientIpFrom } from "@/lib/checkout/rate-limit";
import { validEmail } from "@/lib/comms/smtp";

/**
 * Public: the login page's "Forgot password?" form posts here. The same
 * reply goes back whether or not the account exists.
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

  try {
    const outcome = await requestPasswordReset(email, clientIpFrom(request));
    if (outcome === "limited") {
      return NextResponse.json(
        { error: "Too many reset requests. Try again in an hour." },
        { status: 429 },
      );
    }
    return NextResponse.json(outcome === "fallback" ? { fallback: true } : { ok: true });
  } catch (err) {
    console.error("[password-reset] send failed", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Could not send the reset email. Try again shortly." },
      { status: 502 },
    );
  }
}
