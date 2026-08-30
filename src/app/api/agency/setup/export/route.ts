import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import { KNOWN_KEYS, isPresent, isWritableKey } from "@/lib/setup/catalog";
import {
  isLocalDev,
  readEnvLocalLines,
  formatEnvLine,
} from "@/lib/setup/env-file";

/**
 * Return the deployment's locally-stored env values, UNMASKED, as ready-to-paste
 * `.env` lines — so a local owner who has just filled in `.env.local` can copy
 * the whole set into Vercel by hand.
 *
 * Security — this is the ONE setup route that returns real secret values, so the
 * guard is strict and non-negotiable:
 *   • agency owner only (`requireAgencyOwner`), AND
 *   • `isLocalDev()` — i.e. NOT running on Vercel (`process.env.VERCEL !== "1"`).
 *     On any deployed instance this 403s, so secrets never travel over the wire
 *     from a hosted server. Locally the owner can already read `.env.local` off
 *     disk, so surfacing the same values in-app leaks nothing new.
 *
 * Only catalog-known keys are returned (never the raw `process.env`), so system
 * vars like PATH can't leak. File lines are preserved verbatim (quotes/escapes)
 * so the `\n`-escaped private key round-trips into Vercel intact.
 */
export async function GET(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  if (!isLocalDev()) {
    return NextResponse.json(
      { error: "Only available when running locally." },
      { status: 403 },
    );
  }

  const fileLines = readEnvLocalLines();
  // `line` is the paste-ready `.env` line (verbatim); `value` is the unquoted
  // value, used for the hover-to-reveal on the status board.
  const stored: { key: string; line: string; value: string }[] = [];

  // Catalog order → a readable, grouped block. Prefer the raw `.env.local` line
  // (verbatim); fall back to a formatted value from process.env (e.g. a var set
  // via the shell rather than the file).
  for (const key of KNOWN_KEYS) {
    // Never surface the preflight VERCEL_* credentials — you don't paste them
    // back into Vercel, and VERCEL_TOKEN especially must never leak here.
    if (!isWritableKey(key)) continue;
    const fromFile = fileLines.get(key);
    if (fromFile) {
      if (isPresent(fromFile.value))
        stored.push({ key, line: fromFile.line, value: fromFile.value });
      continue;
    }
    const fromEnv = process.env[key];
    if (isPresent(fromEnv)) {
      const value = (fromEnv ?? "").trim();
      stored.push({ key, line: formatEnvLine(key, value), value });
    }
  }

  return NextResponse.json({ ok: true, stored });
}
