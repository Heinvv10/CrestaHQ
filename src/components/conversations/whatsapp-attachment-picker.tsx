"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  capabilitiesFor,
  SHRINKABLE_IMAGE_TYPES,
  TRANSCODABLE_VIDEO_TYPES,
  uploadCapFor,
  type WhatsAppProviderCapabilities,
  type WhatsAppProviderId,
} from "@/lib/comms/whatsapp/provider";
import { checkWhatsappVideoCodecs } from "@/lib/comms/whatsapp/video-codec";
import { mediaKindForMime } from "@/types/whatsapp-media";

/**
 * What the send route accepts as `attachment`: a file already uploaded to
 * Storage, named by the id `/api/comms/whatsapp/upload-url` issued. The route
 * reads the object's real type and size from Storage; `contentType` here is
 * informational.
 */
export interface ComposerAttachment {
  stagedId: string;
  filename: string;
  contentType: string;
}

/** A failure whose message is written for the operator. Anything else gets the generic line. */
class UploadRefused extends Error {}

/**
 * Every type the picker offers: what the rail sends, plus photos the send
 * route converts to JPEG, plus phone videos where the host converts them.
 */
function acceptedTypes(caps: WhatsAppProviderCapabilities, host: { videoTranscode: boolean }): string[] {
  return [...new Set([...caps.mediaMimeTypes, ...SHRINKABLE_IMAGE_TYPES, ...TRANSCODABLE_VIDEO_TYPES])].filter(
    (t) => uploadCapFor(caps, t, host) > 0,
  );
}

let videoTranscodeAnswer: Promise<boolean> | null = null;

/**
 * Whether this deployment converts videos (ffmpeg on the server), asked once
 * per page load, and only by a composer on a rail that sends files. False
 * until the answer arrives, and on any failure: the
 * picker then offers only what every host accepts, and the server — which
 * decides — is never more generous than what it said here.
 */
function useVideoTranscode(ask: boolean): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!ask) return;
    let live = true;
    videoTranscodeAnswer ??= fetch("/api/comms/whatsapp/upload-url")
      .then(async (res) => res.ok && ((await res.json()) as { videoTranscode?: unknown }).videoTranscode === true)
      .catch(() => false);
    void videoTranscodeAnswer.then((v) => {
      if (live) setOn(v);
    });
    return () => {
      live = false;
    };
  }, [ask]);
  return on;
}

/** By name as well as type: some browsers report a .heic file's type as "". */
function isHeic(file: File): boolean {
  return /^image\/hei[cf]/.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

function humanSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
  return `${bytes} B`;
}

export interface WhatsappAttachmentState {
  /** Null while nothing is attached, and while a file is still uploading. */
  attachment: ComposerAttachment | null;
  /** True between picking a file and its upload finishing. Send waits. */
  uploading: boolean;
  /** The server converts phone videos: they may be larger, HEVC, or `.mov`. */
  videoTranscode: boolean;
  pick: (file: File) => void;
  clear: () => void;
}

/**
 * The composer's one attachment, scoped to `resetKey` (contact + channel).
 *
 * The file is uploaded to Storage as soon as it is picked — a signed URL from
 * `/api/comms/whatsapp/upload-url`, then a PUT of the raw file — so Send posts
 * only its id. That upload is asynchronous, and both ways of getting that
 * wrong reach a customer: Send pressed mid-upload goes out as the caption
 * alone, and an upload that finishes after the operator moved on attaches the
 * file to the NEXT message — possibly on another channel or to another
 * contact. So `uploading` is exposed for the composer to block Send on, and
 * every upload carries a generation that a newer pick, a clear, or a
 * `resetKey` change invalidates; a stale result is dropped, never applied.
 */
export function useWhatsappAttachment(
  provider: WhatsAppProviderId | null,
  contactId: string,
  resetKey: string,
): WhatsappAttachmentState {
  const [state, setState] = useState<{
    key: string;
    gen: number;
    attachment: ComposerAttachment | null;
    uploading: boolean;
  }>({ key: resetKey, gen: 0, attachment: null, uploading: false });
  const genRef = useRef(0);
  const videoTranscode = useVideoTranscode(provider !== null && capabilitiesFor(provider).supportsMedia);

  // A contact or channel change DISCARDS the attachment — a finished one as
  // well as an upload in flight. Hiding it instead would bring it back on the
  // way back to the same key, and the next unrelated message would send it.
  useEffect(() => {
    genRef.current += 1;
    setState((s) =>
      s.key === resetKey
        ? s
        : { key: resetKey, gen: genRef.current, attachment: null, uploading: false },
    );
  }, [resetKey]);

  // LOAD-BEARING, not a nicety. The effect above clears only after the render
  // that carries the new key has committed; during that render `state` still
  // holds the old key's file. A caller that changes the key programmatically
  // (the inbox composer switches to email inside an effect) would otherwise
  // see that file under the new key. Pinned by whatsapp-attachment-picker.test.ts.
  const current = state.key === resetKey ? state : null;

  function pick(file: File) {
    if (!provider) return;
    const caps = capabilitiesFor(provider);
    if (isHeic(file)) {
      toast.error(
        `${file.name}: iPhone HEIC photos aren't supported yet — set iPhone Camera to 'Most Compatible' or send as JPEG.`,
      );
      return;
    }
    // A photo over the rail's image cap is allowed up to the raw upload cap:
    // the send route shrinks it to fit. So is a video, where the server
    // transcodes.
    const cap = uploadCapFor(caps, file.type, { videoTranscode });
    if (cap === 0) {
      toast.error(`${file.name}: this file type cannot be sent on WhatsApp here.`);
      return;
    }
    const kind = mediaKindForMime(file.type);
    if (file.size === 0) {
      toast.error(`${file.name} is empty.`);
      return;
    }
    if (file.size > cap) {
      toast.error(
        `${file.name} is ${humanSize(file.size)}; the limit for a ${kind} is ${humanSize(cap)}.`,
      );
      return;
    }
    const gen = ++genRef.current;
    const key = resetKey;
    setState({ key, gen, attachment: null, uploading: true });
    const settle = (attachment: ComposerAttachment | null) =>
      setState((s) => (s.gen === gen ? { ...s, attachment, uploading: false } : s));
    // Stale: a newer pick, a clear, or a contact/channel change since.
    const stale = () => genRef.current !== gen;

    void (async () => {
      try {
        // Early word on a video WhatsApp cannot play, instead of after Send.
        // The send route runs the same check, and that one is what counts.
        // The raw bytes, not base64; a video is capped at 16 MiB. Skipped
        // where the server transcodes: it converts such a video instead.
        if (file.type === "video/mp4" && !videoTranscode) {
          const codecs = checkWhatsappVideoCodecs(new Uint8Array(await file.arrayBuffer()));
          if (stale()) return settle(null);
          if (!codecs.ok) {
            settle(null);
            toast.error(`${file.name}: ${codecs.message}`);
            return;
          }
        }
        const res = await fetch("/api/comms/whatsapp/upload-url", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contactId, contentType: file.type, sizeBytes: file.size }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          stagedId?: string;
          uploadUrl?: string;
          contentLengthRange?: string;
          error?: string;
        };
        if (stale()) return settle(null);
        if (!res.ok || !data.stagedId || !data.uploadUrl || !data.contentLengthRange) {
          throw new UploadRefused(data.error ?? `Couldn't upload ${file.name}.`);
        }
        // Both headers are part of the URL's signature: the exact type the URL
        // was issued for, and the size range Storage enforces on the body.
        // Either one missing or changed, and Storage refuses the PUT.
        const put = await fetch(data.uploadUrl, {
          method: "PUT",
          headers: {
            "content-type": file.type,
            "x-goog-content-length-range": data.contentLengthRange,
          },
          body: file,
        });
        if (stale()) return settle(null);
        if (!put.ok) throw new UploadRefused(`Couldn't upload ${file.name}.`);
        settle({ stagedId: data.stagedId, filename: file.name, contentType: file.type });
      } catch (err) {
        settle(null);
        if (!stale()) {
          toast.error(err instanceof UploadRefused ? err.message : `Couldn't upload ${file.name}.`);
        }
      }
    })();
  }

  function clear() {
    genRef.current += 1;
    setState({ key: resetKey, gen: genRef.current, attachment: null, uploading: false });
  }

  return {
    attachment: current?.attachment ?? null,
    uploading: current?.uploading ?? false,
    videoTranscode,
    pick,
    clear,
  };
}

/**
 * Paperclip + hidden file input for the WhatsApp composers. Renders nothing on
 * a rail whose capabilities say it cannot carry a file (Twilio), and derives
 * its accept-list and per-kind size caps from the SAME capability record the
 * rails enforce — so an operator is never offered a file the rail will then
 * refuse after the upload.
 *
 * The check here is a courtesy; the rail decides.
 */
export function WhatsappAttachmentPicker({
  provider,
  state,
  disabled,
}: {
  provider: WhatsAppProviderId;
  state: WhatsappAttachmentState;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const caps = capabilitiesFor(provider);
  if (!caps.supportsMedia) return null;
  const { attachment, uploading } = state;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        hidden
        data-testid="whatsapp-attachment-input"
        accept={acceptedTypes(caps, { videoTranscode: state.videoTranscode }).join(",")}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so picking the same file again re-fires onChange.
          e.target.value = "";
          if (file) state.pick(file);
        }}
      />
      {uploading ? (
        <span className="text-muted-foreground inline-flex items-center gap-1 px-2 py-1 text-xs">
          <Loader2 className="h-3 w-3 animate-spin" />
          Uploading file…
        </span>
      ) : attachment ? (
        <span className="bg-muted inline-flex max-w-[16rem] items-center gap-1 rounded-md px-2 py-1 text-xs">
          <Paperclip className="h-3 w-3 shrink-0" />
          <span className="truncate" title={attachment.filename}>
            {attachment.filename}
          </span>
          <button
            type="button"
            aria-label="Remove attachment"
            className="ml-1 shrink-0 opacity-70 hover:opacity-100"
            onClick={state.clear}
            disabled={disabled}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          title="Attach a file"
        >
          <Paperclip className="mr-1 h-3.5 w-3.5" />
          Attach
        </Button>
      )}
    </>
  );
}

/**
 * Why Send is blocked by the attachment, or null. Shared by both composers so
 * the caption rule reads the same capability the rail enforces.
 */
export function attachmentSendBlock(
  provider: WhatsAppProviderId | null,
  state: WhatsappAttachmentState,
  body: string,
): string | null {
  if (state.uploading) return "Uploading file…";
  if (!state.attachment || !provider) return null;
  const max = capabilitiesFor(provider).maxMediaCaptionChars;
  // Code points, as the bridge's maxTextRunes counts — see provider.ts.
  const len = [...body.trim()].length;
  return len > max
    ? `With a file attached the message is its caption: ${len} of ${max} characters allowed.`
    : null;
}
