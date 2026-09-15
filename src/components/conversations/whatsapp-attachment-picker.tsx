"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { capabilitiesFor, type WhatsAppProviderId } from "@/lib/comms/whatsapp/provider";
import { mediaKindForMime } from "@/types/whatsapp-media";

/** What the send route accepts as `attachment`. */
export interface ComposerAttachment {
  filename: string;
  contentType: string;
  dataBase64: string;
}

function humanSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
  return `${bytes} B`;
}

export interface WhatsappAttachmentState {
  /** Null while nothing is attached, and while a file is still being read. */
  attachment: ComposerAttachment | null;
  /** True between picking a file and its bytes being ready. Send waits. */
  reading: boolean;
  pick: (file: File) => void;
  clear: () => void;
}

/**
 * The composer's one attachment, scoped to `resetKey` (contact + channel).
 *
 * Reading a file is asynchronous, and both ways of getting that wrong reach a
 * customer: Send pressed mid-read goes out as the caption alone, and a read
 * that lands after the operator moved on attaches the file to the NEXT
 * message — possibly on another channel or to another contact. So `reading`
 * is exposed for the composer to block Send on, and every read carries a
 * generation that a newer pick, a clear, or a `resetKey` change invalidates;
 * a stale result is dropped, never applied.
 */
export function useWhatsappAttachment(
  provider: WhatsAppProviderId | null,
  resetKey: string,
): WhatsappAttachmentState {
  const [state, setState] = useState<{
    key: string;
    gen: number;
    attachment: ComposerAttachment | null;
    reading: boolean;
  }>({ key: resetKey, gen: 0, attachment: null, reading: false });
  const genRef = useRef(0);

  // A contact or channel change DISCARDS the attachment — a finished one as
  // well as a read in flight. Hiding it instead would bring it back on the
  // way back to the same key, and the next unrelated message would send it.
  useEffect(() => {
    genRef.current += 1;
    setState((s) =>
      s.key === resetKey
        ? s
        : { key: resetKey, gen: genRef.current, attachment: null, reading: false },
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
    if (!caps.mediaMimeTypes.includes(file.type)) {
      toast.error(`${file.name}: this file type cannot be sent on WhatsApp here.`);
      return;
    }
    const kind = mediaKindForMime(file.type);
    const cap = caps.maxMediaBytes[kind];
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
    setState({ key, gen, attachment: null, reading: true });
    const settle = (attachment: ComposerAttachment | null) =>
      setState((s) => (s.gen === gen ? { ...s, attachment, reading: false } : s));
    const reader = new FileReader();
    reader.onload = () => {
      // Stale: a newer pick, a clear, or a contact/channel change since.
      if (genRef.current !== gen) {
        settle(null);
        return;
      }
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      // A bare "data:" (Chromium, for an empty blob) has no payload at all;
      // slicing past a missing comma would send "data:" as the file.
      if (comma < 0 || comma === url.length - 1) {
        settle(null);
        toast.error(`Couldn't read ${file.name}.`);
        return;
      }
      settle({
        filename: file.name,
        contentType: file.type,
        dataBase64: url.slice(comma + 1),
      });
    };
    reader.onerror = () => {
      settle(null);
      if (genRef.current === gen) toast.error(`Couldn't read ${file.name}.`);
    };
    reader.readAsDataURL(file);
  }

  function clear() {
    genRef.current += 1;
    setState({ key: resetKey, gen: genRef.current, attachment: null, reading: false });
  }

  return {
    attachment: current?.attachment ?? null,
    reading: current?.reading ?? false,
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
  const { attachment, reading } = state;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        hidden
        data-testid="whatsapp-attachment-input"
        accept={caps.mediaMimeTypes.join(",")}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so picking the same file again re-fires onChange.
          e.target.value = "";
          if (file) state.pick(file);
        }}
      />
      {reading ? (
        <span className="text-muted-foreground inline-flex items-center gap-1 px-2 py-1 text-xs">
          <Loader2 className="h-3 w-3 animate-spin" />
          Reading file…
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
  if (state.reading) return "Reading file…";
  if (!state.attachment || !provider) return null;
  const max = capabilitiesFor(provider).maxMediaCaptionChars;
  // Code points, as the bridge's maxTextRunes counts — see provider.ts.
  const len = [...body.trim()].length;
  return len > max
    ? `With a file attached the message is its caption: ${len} of ${max} characters allowed.`
    : null;
}
