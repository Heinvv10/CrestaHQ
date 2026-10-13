import "server-only";

import { createHash } from "node:crypto";

import { getWabaCreds } from "./cloud-credentials";
import { graphVersion } from "./graph-version";
import type { WhatsappMediaDropped } from "@/types/whatsapp-media";

/**
 * Download one inbound WhatsApp Cloud media file. Two Graph calls:
 *
 *   1. GET /{version}/{mediaId}           → { url, mime_type, sha256, file_size }
 *   2. GET <that url> with the same bearer → the bytes
 *
 * Meta requires the token on the second call too; without it the CDN 401s.
 *
 * Never throws. Every failure is a `WhatsappMediaDropped` reason and nothing
 * else — no free-text error travels back to the caller, so nothing the caller
 * logs or stores can carry the access token.
 */

/** Ruling 4's cap, and the Cloud API's own documented ceiling for video. */
const MAX_CLOUD_MEDIA_BYTES = 16 << 20;

/** A JSON metadata round trip. Anything slower is Graph being unwell. */
const METADATA_TIMEOUT_MS = 3_000;

/**
 * The bytes. 16 MiB in 3 s would need ~43 Mbit/s; 15 s needs ~9. The route
 * runs this after the inbox entry and any AI reply, so a slow download delays
 * only the ack and the attachment.
 */
const DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * Both calls are idempotent GETs, so a transient failure — a network error,
 * a timeout, a 429 or a 5xx — is retried in place. A single dropped
 * connection on 2026-10-13 otherwise lost a customer's photo for good.
 */
const ATTEMPTS = 3;
const BACKOFF_MS = [500, 1_500];

/**
 * `transient` failures are worth Meta redelivering the webhook for; the
 * route answers non-2xx on them. A refusal (4xx, bad digest, foreign host,
 * too large) is final and is not.
 */
type CloudMediaFetch =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: WhatsappMediaDropped; transient: boolean };

class TransientStatus extends Error {}

/** fetch throws `TypeError("fetch failed")` with the undici code on `cause`. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { cause?: { code?: unknown } }).cause?.code;
  return `${err.name}: ${err.message}${typeof code === "string" ? ` (${code})` : ""}`;
}

/**
 * Runs `call` up to ATTEMPTS times. A thrown error or a 429/5xx is retried;
 * any other response is returned as-is for the caller to judge. After the
 * last attempt the error (or a TransientStatus) is thrown.
 */
async function withRetry(
  label: string,
  subAccountId: string,
  token: string,
  call: () => Promise<Response>,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let failure: unknown;
    try {
      const res = await call();
      if (res.status !== 429 && res.status < 500) return res;
      await res.body?.cancel().catch(() => undefined);
      failure = new TransientStatus(`${label} ${res.status}`);
    } catch (err) {
      failure = err;
    }
    if (attempt >= ATTEMPTS) throw failure;
    console.warn(
      `[whatsapp-cloud-media] ${label} attempt=${attempt}/${ATTEMPTS} failed, retrying (sa=${subAccountId}): ${redact(describeError(failure), token)}`,
    );
    await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
  }
}

/**
 * Hosts the bearer token may be sent to. The token is a long-lived WABA
 * system-user token; a metadata response naming any other host must not
 * receive it.
 *
 * `lookaside.fbsbx.com` is Meta's WhatsApp media CDN; `whatsapp.net` is also
 * Meta's. Matched on a real hostname suffix — `fbsbx.com.evil.example` is not
 * `fbsbx.com`. If Meta moves its CDN, the warn below names the new host.
 */
const MEDIA_HOST_SUFFIXES = ["fbsbx.com", "whatsapp.net"];

function isMetaMediaUrl(raw: string): { ok: boolean; host: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, host: "(unparseable)" };
  }
  const host = url.hostname.toLowerCase();
  const ok =
    url.protocol === "https:" &&
    url.port === "" &&
    MEDIA_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  return { ok, host };
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

/** Meta's examples show a number; at least one client library types `file_size`
 *  as a string. Both are accepted — the streaming cap is the real enforcement. */
function declaredSize(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Reads at most `maxBytes`, cancelling the stream the moment it would exceed
 * them. `file_size` is the sender's claim; this is the enforcement.
 */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<Buffer | "too_large"> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Meta's docs do not pin the digest encoding, and a wrong guess here would
 * drop EVERY media message, so both encodings of the SAME digest are accepted.
 * This is still an exact comparison — neither form matches different bytes.
 */
function digestMatches(bytes: Buffer, claimed: string): boolean {
  const digest = createHash("sha256").update(bytes).digest();
  return (
    claimed.toLowerCase() === digest.toString("hex") ||
    claimed === digest.toString("base64")
  );
}

export async function fetchCloudMedia(opts: {
  subAccountId: string;
  mediaId: string;
}): Promise<CloudMediaFetch> {
  let token = "";
  try {
    token = (await getWabaCreds(opts.subAccountId)).accessToken;
  } catch (err) {
    // No usable connection is config, not a blip — Meta redelivering the
    // webhook would meet it again.
    console.warn(
      `[whatsapp-cloud-media] no WABA credentials (sa=${opts.subAccountId}): ${describeError(err)}`,
    );
    return { ok: false, reason: "fetch_failed", transient: false };
  }
  try {
    const auth = { Authorization: `Bearer ${token}` };

    const metaRes = await withRetry("metadata", opts.subAccountId, token, () =>
      fetch(
        `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(opts.mediaId)}`,
        { headers: auth, signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) },
      ),
    );
    if (!metaRes.ok) {
      console.warn(
        `[whatsapp-cloud-media] metadata ${metaRes.status} (sa=${opts.subAccountId})`,
      );
      return { ok: false, reason: "fetch_failed", transient: false };
    }
    const meta = (await metaRes.json()) as Record<string, unknown>;
    const url = typeof meta.url === "string" ? meta.url : "";
    const sha256 = typeof meta.sha256 === "string" ? meta.sha256 : "";
    if (!url || !sha256) {
      console.warn(
        `[whatsapp-cloud-media] metadata missing url or sha256 (sa=${opts.subAccountId})`,
      );
      return { ok: false, reason: "fetch_failed", transient: false };
    }
    const target = isMetaMediaUrl(url);
    if (!target.ok) {
      // Loud on purpose: this is either an attack or Meta moving its CDN, and
      // the second must show up in journalctl rather than as silent drops.
      console.warn(
        `[whatsapp-cloud-media] REFUSING media download from non-Meta host "${target.host}" — token withheld (sa=${opts.subAccountId})`,
      );
      return { ok: false, reason: "fetch_failed", transient: false };
    }
    const size = declaredSize(meta.file_size);
    if (size !== null && size > MAX_CLOUD_MEDIA_BYTES) {
      return { ok: false, reason: "too_large", transient: false };
    }

    const bytesRes = await withRetry("download", opts.subAccountId, token, () =>
      fetch(url, {
        headers: auth,
        // A redirect would carry the bearer token to wherever it points.
        redirect: "error",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      }),
    );
    if (!bytesRes.ok) {
      console.warn(
        `[whatsapp-cloud-media] download ${bytesRes.status} (sa=${opts.subAccountId})`,
      );
      return { ok: false, reason: "fetch_failed", transient: false };
    }
    const bytes = await readCapped(bytesRes, MAX_CLOUD_MEDIA_BYTES);
    if (bytes === "too_large") return { ok: false, reason: "too_large", transient: false };

    if (!digestMatches(bytes, sha256)) {
      console.warn(
        `[whatsapp-cloud-media] sha256 mismatch — not storing (sa=${opts.subAccountId})`,
      );
      return { ok: false, reason: "fetch_failed", transient: false };
    }
    return { ok: true, bytes };
  } catch (err) {
    // A message only, and redacted: an error object can carry request detail,
    // and the one thing this line must never print is the bearer token.
    // Retries are spent by now (or the failure was mid-body / credentials), so
    // the route asks Meta to redeliver, which re-attempts the attachment.
    console.warn(
      `[whatsapp-cloud-media] fetch failed (sa=${opts.subAccountId}): ${redact(describeError(err), token)}`,
    );
    return { ok: false, reason: "fetch_failed", transient: true };
  }
}
