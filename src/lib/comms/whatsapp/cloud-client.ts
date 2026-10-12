import "server-only";

import {
  capabilitiesFor,
  httpFailureOutcome,
  type OutboundAttachment,
  type WhatsAppProviderId,
  type WhatsAppSendResult,
} from "./provider";
import { resolveWaSendMode, type WaSendMode } from "./send-mode";
import { graphVersion } from "./graph-version";
import type { WhatsappCloudSecret } from "@/types/whatsapp-cloud";
import type { CloudInteractive } from "./interactive";
import { mediaKindForMime, type WhatsappMediaKind } from "@/types/whatsapp-media";

/**
 * Meta WhatsApp Cloud API sender — the `cloud` arm of the provider seam.
 *
 * Returns a `WhatsAppSendResult` and never throws, so the dispatch layer can
 * treat every rail identically (the `WaResult` contract borrowed from
 * ndzinga-lms). Errors become `ok: false` with a retry verdict attached.
 */

/** A resolved, approved template ready to send. `approved` is carried
 *  explicitly because an unapproved template must be treated as absent. */
export interface CloudTemplateRef {
  name: string;
  language: string;
  components: unknown[];
  approved: boolean;
}

/**
 * Meta wants a bare international number: no `+`, no separators, and none of
 * Twilio's `whatsapp:` addressing. Numbers reaching this rail may have been
 * stored by the Twilio path, so the prefix is stripped rather than assumed
 * absent.
 */
export function normalizeWaPhone(raw: string): string {
  const bare = raw.startsWith("whatsapp:") ? raw.slice("whatsapp:".length) : raw;
  return bare.replace(/[^\d]/g, "");
}

/** An uploaded file, ready to be referenced by a message. */
export interface CloudMediaRef {
  id: string;
  kind: WhatsappMediaKind;
  /** Shown to the recipient on a document; ignored by Meta for other kinds. */
  filename: string;
}

export function buildCloudMessageBody(
  decision: WaSendMode,
  to: string,
  message: string,
  template: Pick<CloudTemplateRef, "name" | "language" | "components"> | null,
  /** In-window buttons. Used only in text mode: interactive messages are
   *  free-form, so like plain text they are allowed only inside the window. */
  interactive: CloudInteractive | null = null,
  /** An uploaded file. Text mode only — the message rides as its caption. */
  media: CloudMediaRef | null = null,
): Record<string, unknown> {
  const recipient = normalizeWaPhone(to);
  if (decision.mode === "text" && interactive) {
    return { messaging_product: "whatsapp", to: recipient, type: "interactive", interactive };
  }
  if (decision.mode === "text" && media) {
    return {
      messaging_product: "whatsapp",
      to: recipient,
      type: media.kind,
      [media.kind]: {
        id: media.id,
        // Omitted, not "", on a file sent with no text.
        ...(message ? { caption: message } : {}),
        ...(media.kind === "document" ? { filename: media.filename } : {}),
      },
    };
  }
  if (decision.mode === "template" && template) {
    return {
      messaging_product: "whatsapp",
      to: recipient,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        components: template.components,
      },
    };
  }
  // Defensive fallback. The decision layer should never ask for template mode
  // without a template; if it does, text is strictly safer than emitting
  // `template: undefined`, which Meta answers with a 400 an operator can do
  // nothing about.
  return {
    messaging_product: "whatsapp",
    to: recipient,
    type: "text",
    text: { body: message },
  };
}

/** Meta echoes the offending token back in some auth errors. Send results are
 *  shown to operators and written to logs, so scrub it before returning. */
function redact(text: string, accessToken: string): string {
  return accessToken ? text.split(accessToken).join("[redacted]") : text;
}

/**
 * `POST /{phoneNumberId}/media` — multipart, returns the media id a message
 * then references. Never throws.
 *
 * Every failure is DEFINITELY_REJECTED, whatever the status: the upload
 * strictly precedes the send, so nothing has reached the customer and a retry
 * cannot double-message. That is the same invariant the bridge's
 * `ErrMediaUpload` documents, and it is what lets the route answer 400.
 */
export async function uploadCloudMedia(opts: {
  creds: WhatsappCloudSecret;
  filename: string;
  contentType: string;
  data: Blob;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; mediaId: string }
  | { ok: false; error: string; providerErrorCode: "media_upload_failed"; providerOutcome: "DEFINITELY_REJECTED" }
> {
  const fail = (error: string) =>
    ({
      ok: false,
      error,
      providerErrorCode: "media_upload_failed",
      providerOutcome: "DEFINITELY_REJECTED",
    }) as const;
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", opts.contentType);
  // A File over the Blob references its bytes rather than copying them.
  form.set("file", new File([opts.data], opts.filename, { type: opts.contentType }));
  const url = `https://graph.facebook.com/${graphVersion()}/${opts.creds.phoneNumberId}/media`;
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method: "POST",
      // No Content-Type: fetch writes the multipart boundary itself.
      headers: { Authorization: `Bearer ${opts.creds.accessToken}` },
      body: form,
      // Measured, not decorative: with redirects allowed undici holds a full
      // second copy of the body for a possible replay — +95 MiB on a 100 MB
      // document. Graph does not redirect this call, and a redirect would
      // carry the bearer token wherever it pointed.
      redirect: "error",
      // 30 s plus a second per MB: a flat 30 s would need ~27 Mbit/s of
      // upstream to get a 100 MB document to Graph in time.
      signal:
        opts.signal ?? AbortSignal.timeout(30_000 + Math.ceil(opts.data.size / 1_000_000) * 1_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "unknown error");
      return fail(`WhatsApp Cloud media upload ${res.status}: ${redact(text, opts.creds.accessToken)}`);
    }
    const data = (await res.json()) as { id?: string };
    const mediaId = data.id?.trim();
    if (!mediaId) return fail("WhatsApp Cloud media upload returned no id");
    return { ok: true, mediaId };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "WhatsApp Cloud media upload failed");
  }
}

/** Meta shows a document's filename to the recipient; the bridge caps at 255. */
const MAX_FILENAME_BYTES = 255;

/**
 * Characters stripped from an outbound filename: C0, DEL and C1 controls, the
 * line/paragraph separators, zero-width space, BOM, and every bidi control.
 * The bidi ones are the reason this is more than hygiene: a right-to-left
 * override turns `invoice<RLO>fdp.exe` into "invoiceexe.pdf" on the customer's
 * phone, under the business's name.
 */
const FILENAME_STRIP =
  /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * The filename as it goes to Graph: lone surrogates replaced (so the
 * multipart name and `document.filename` cannot diverge on the wire), the
 * characters above stripped, then cut to 255 UTF-8 bytes on a code-point
 * boundary with the extension kept.
 *
 * The send route already refuses a name over 255 bytes, so the cut guards
 * only a caller that reaches this rail some other way.
 *
 * The same rule exists on the inbound branches (#148, #151); the three copies
 * should become one once those merge.
 */
function cloudFilename(raw: string): string {
  const clean = raw.toWellFormed().replace(FILENAME_STRIP, "").trim() || "file";
  const bytes = (s: string) => Buffer.byteLength(s, "utf8");
  if (bytes(clean) <= MAX_FILENAME_BYTES) return clean;
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
  const base = [...clean.slice(0, clean.length - ext.length)];
  while (base.length > 0 && bytes(base.join("")) + bytes(ext) > MAX_FILENAME_BYTES) {
    base.pop();
  }
  return base.join("") + ext;
}

/**
 * Undici error codes (on `cause`) that mean the connection was never
 * established, so the request body cannot have reached Meta and a retry cannot
 * double-message. Everything else — a reset, a socket error, a timeout after
 * connecting — may have been delivered and stays AMBIGUOUS. ETIMEDOUT is left
 * out on purpose: it is also raised on an established socket.
 */
const PRE_CONNECT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Backoff before each retry of a pre-connect failure: 3 attempts in all. */
const PRE_CONNECT_RETRY_DELAYS_MS = [1_000, 3_000];

/** fetch throws `TypeError("fetch failed")` with the code on `cause`. */
function fetchErrorCode(e: unknown): string | null {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  const code = err?.cause?.code ?? err?.code;
  return typeof code === "string" ? code : null;
}

export async function sendWhatsappCloud(opts: {
  subAccountId: string;
  creds: WhatsappCloudSecret;
  to: string;
  message: string;
  /** When the contact last messaged in — drives the 24h service window. */
  lastInboundAt: Date | null;
  template: CloudTemplateRef | null;
  interactive?: CloudInteractive | null;
  /** Uploaded before the send; the message then carries its id. */
  media?: OutboundAttachment | null;
  windowHours?: number;
  provider?: WhatsAppProviderId;
  now?: Date;
  signal?: AbortSignal;
}): Promise<WhatsAppSendResult> {
  const capabilities = capabilitiesFor(opts.provider ?? "cloud");
  const decision = resolveWaSendMode({
    lastInboundAt: opts.lastInboundAt,
    // An unapproved template is treated as no template at all: Meta rejects it
    // anyway, and attempting it burns a send and confuses the operator.
    hasApprovedTemplate: opts.template?.approved === true,
    now: opts.now ?? new Date(),
    windowHours: opts.windowHours,
    capabilities,
  });

  if (decision.mode === "error") {
    return {
      ok: false,
      error: decision.error,
      providerOutcome: decision.providerOutcome,
    };
  }

  let media: CloudMediaRef | null = null;
  if (opts.media) {
    // A file rides only on a plain in-window message. A template cannot carry
    // one, and buttons are their own message type; refusing beats sending the
    // caption without the file, which is the one outcome nobody can detect.
    if (decision.mode !== "text" || opts.interactive) {
      return {
        ok: false,
        error: "An attachment can only go with a plain in-window message.",
        providerOutcome: "DEFINITELY_REJECTED",
        providerErrorCode: "media_invalid",
      };
    }
    // The rail enforces what it declares, so a caller that skipped the
    // composer's picker gets the same answer as one that used it — and an
    // oversized file is never pushed at Graph only to be refused there.
    const captionChars = [...opts.message].length;
    if (captionChars > capabilities.maxMediaCaptionChars) {
      return {
        ok: false,
        error: `A message sent with a file is its caption, and WhatsApp allows ${capabilities.maxMediaCaptionChars} characters; this one is ${captionChars}.`,
        providerOutcome: "DEFINITELY_REJECTED",
        providerErrorCode: "caption_too_long",
      };
    }
    const size = opts.media.data.size;
    const kind = mediaKindForMime(opts.media.contentType);
    const cap = capabilities.maxMediaBytes[kind];
    if (size > cap) {
      return {
        ok: false,
        error: `Attachment is ${size} bytes; the limit for ${kind} is ${cap}.`,
        providerOutcome: "DEFINITELY_REJECTED",
        providerErrorCode: "media_too_large",
      };
    }
    if (!capabilities.mediaMimeTypes.includes(opts.media.contentType)) {
      return {
        ok: false,
        error: `Attachment type ${opts.media.contentType} cannot be sent on this rail.`,
        providerOutcome: "DEFINITELY_REJECTED",
        providerErrorCode: "media_unsupported_type",
      };
    }
    const filename = cloudFilename(opts.media.filename);
    const up = await uploadCloudMedia({
      creds: opts.creds,
      filename,
      contentType: opts.media.contentType,
      data: opts.media.data,
      signal: opts.signal,
    });
    if (!up.ok) return up;
    media = { id: up.mediaId, kind, filename };
  }

  const body = buildCloudMessageBody(
    decision,
    opts.to,
    opts.message,
    opts.template?.approved ? opts.template : null,
    opts.interactive ?? null,
    media,
  );

  const url = `https://graph.facebook.com/${graphVersion()}/${opts.creds.phoneNumberId}/messages`;
  const attempts = PRE_CONNECT_RETRY_DELAYS_MS.length + 1;

  try {
    let res: Response;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.creds.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: opts.signal ?? AbortSignal.timeout(15_000),
        });
        break;
      } catch (e) {
        const code = fetchErrorCode(e);
        // Code and attempt only: the token, body and recipient stay out of logs.
        console.warn(
          `[whatsapp-cloud] messages POST threw (sa=${opts.subAccountId} attempt=${attempt}/${attempts} ` +
            `name=${e instanceof Error ? e.name : typeof e} code=${code ?? "none"})`,
        );
        if (!code || !PRE_CONNECT_CODES.has(code)) throw e;
        if (attempt === attempts) {
          // No connection was ever made, so nothing reached Meta: the caller
          // may treat this as unsent.
          return {
            ok: false,
            error: `fetch failed (${code}) after ${attempts} attempts`,
            providerOutcome: "DEFINITELY_REJECTED",
            attempted: false,
          };
        }
        await new Promise((r) => setTimeout(r, PRE_CONNECT_RETRY_DELAYS_MS[attempt - 1]));
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "unknown error");
      return {
        ok: false,
        error: `WhatsApp Cloud ${res.status}: ${redact(text, opts.creds.accessToken)}`,
        providerOutcome: httpFailureOutcome(res.status),
      };
    }

    const data = (await res.json()) as { messages?: Array<{ id?: string }> };
    const messageId = data.messages?.[0]?.id?.trim();
    if (!messageId) {
      // Success without an id would write a message row carrying no provider
      // reference, so no delivery receipt could ever be matched back to it.
      return {
        ok: false,
        error: "WhatsApp Cloud returned success without a provider message id",
        providerOutcome: "AMBIGUOUS",
      };
    }
    return { ok: true, messageId };
  } catch (e) {
    // The request may well have reached Meta. Calling this DEFINITELY_REJECTED
    // would invite a retry that double-messages the customer.
    return {
      ok: false,
      error: e instanceof Error ? e.message : "WhatsApp Cloud request failed",
      providerOutcome: "AMBIGUOUS",
    };
  }
}
