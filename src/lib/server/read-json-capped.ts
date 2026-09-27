import { readBodyCapped } from "@/lib/api/body-limit";

/**
 * The request body parsed as JSON, read no further than `maxBytes` (see
 * readBodyCapped: a truthful, absent or lying Content-Length all hold).
 * "too_large" past the cap (answer 413); "invalid" when it isn't JSON, as
 * `request.json()` would have thrown.
 */
export async function readJsonCapped(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: "too_large" | "invalid" }> {
  const raw = await readBodyCapped(request, maxBytes);
  if (raw === null) return { ok: false, reason: "too_large" };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
