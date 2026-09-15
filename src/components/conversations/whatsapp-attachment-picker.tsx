"use client";

import { useRef } from "react";
import { toast } from "sonner";
import { Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { capabilitiesFor, type WhatsAppProviderId } from "@/lib/comms/whatsapp/provider";

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

/**
 * Paperclip + hidden file input for the WhatsApp composers. Renders nothing on
 * a rail whose capabilities say it cannot carry a file (Twilio), and derives
 * its accept-list and size cap from the SAME capability record the rails
 * enforce — so an operator is never offered a file the rail will then refuse
 * after the upload.
 *
 * The check here is a courtesy; the rail decides. A file that passes here and
 * is still refused (Meta's own per-kind caps, say) comes back as a 400 the
 * composer already shows.
 */
export function WhatsappAttachmentPicker({
  provider,
  value,
  onChange,
  disabled,
}: {
  provider: WhatsAppProviderId;
  value: ComposerAttachment | null;
  onChange: (next: ComposerAttachment | null) => void;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const caps = capabilitiesFor(provider);
  if (!caps.supportsMedia) return null;

  async function pick(file: File) {
    if (file.size > caps.maxMediaBytes) {
      toast.error(
        `${file.name} is ${humanSize(file.size)}; the limit is ${humanSize(caps.maxMediaBytes)}.`,
      );
      return;
    }
    if (!caps.mediaMimeTypes.includes(file.type)) {
      toast.error(`${file.name}: this file type cannot be sent on WhatsApp here.`);
      return;
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    // Chunked: String.fromCharCode(...buf) overflows the argument list on a
    // file of any real size.
    let binary = "";
    for (let i = 0; i < buf.length; i += 0x8000) {
      binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    }
    onChange({ filename: file.name, contentType: file.type, dataBase64: btoa(binary) });
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        hidden
        accept={caps.mediaMimeTypes.join(",")}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so picking the same file again re-fires onChange.
          e.target.value = "";
          if (file) void pick(file);
        }}
      />
      {value ? (
        <span className="bg-muted inline-flex max-w-[16rem] items-center gap-1 rounded-md px-2 py-1 text-xs">
          <Paperclip className="h-3 w-3 shrink-0" />
          <span className="truncate" title={value.filename}>
            {value.filename}
          </span>
          <button
            type="button"
            aria-label="Remove attachment"
            className="ml-1 shrink-0 opacity-70 hover:opacity-100"
            onClick={() => onChange(null)}
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
          title={`Attach a file (up to ${humanSize(caps.maxMediaBytes)})`}
        >
          <Paperclip className="mr-1 h-3.5 w-3.5" />
          Attach
        </Button>
      )}
    </>
  );
}
