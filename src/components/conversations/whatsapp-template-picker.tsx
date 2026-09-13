"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { toast } from "sonner";
import { FileText, Loader2 } from "lucide-react";
import { getFirebaseDb } from "@/lib/firebase/client";
import { useSubAccount } from "@/context/sub-account-context";
import { isTemplateApprovedFor } from "@/lib/comms/whatsapp/template-registrations";
import type { WhatsAppProviderId } from "@/lib/comms/whatsapp/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Contact } from "@/types/contacts";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";

type Template = WhatsappTemplateDoc & { id: string };

/**
 * SP2 T8 — shown in the composer only while the WhatsApp window is closed.
 * Lists the templates APPROVED ON THIS RAIL (a Twilio approval does not make
 * a template sendable on Cloud — `isTemplateApprovedFor`) and sends through
 * the existing `/api/comms/whatsapp/send-template` route, the same one the
 * contact page's template sender uses. The route re-checks the contact,
 * opt-out, agency gate, readiness and the rail's approval.
 *
 * Read straight from Firestore (members may read `whatsappTemplates`), not
 * through the admin-only templates API, so a non-admin operator sees them.
 */
export function WhatsappTemplatePicker({
  contact,
  provider,
}: {
  contact: Contact;
  provider: WhatsAppProviderId;
}) {
  const { subAccountId } = useSubAccount();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [manualValues, setManualValues] = useState<Record<number, string>>({});
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!subAccountId) return;
    return onSnapshot(
      collection(getFirebaseDb(), `subAccounts/${subAccountId}/whatsappTemplates`),
      (snap) =>
        setTemplates(
          snap.docs
            .map((d) => ({ ...(d.data() as WhatsappTemplateDoc), id: d.id }))
            .filter((t) => isTemplateApprovedFor(t, provider))
            .sort((a, b) => a.displayName.localeCompare(b.displayName)),
        ),
      (err) => {
        console.warn("[whatsapp-template-picker] read failed", err);
        setTemplates([]);
      },
    );
  }, [subAccountId, provider]);

  const selected = templates?.find((t) => t.id === selectedId) ?? null;
  const manualVars = selected?.variables.filter((v) => v.source === "manual") ?? [];

  async function send() {
    if (!selected || sending) return;
    const missing = manualVars.find((v) => !(manualValues[v.position] ?? "").trim());
    if (missing) {
      toast.error(`Fill in "${missing.label}".`);
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/comms/whatsapp/send-template", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contactId: contact.id,
          templateId: selected.id,
          manualValues,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `Couldn't send (HTTP ${res.status}).`);
      }
      toast.success("Template sent.");
      setSelectedId("");
      setManualValues({});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      data-testid="wa-template-picker"
      className="mb-2 space-y-2 rounded-md border border-dashed p-2"
    >
      {templates === null ? (
        <p className="text-muted-foreground text-xs">Loading templates…</p>
      ) : templates.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No template is approved for this WhatsApp number yet. Create and
          submit one under AI Agents → WhatsApp → Templates.
        </p>
      ) : (
        <>
          <select
            aria-label="Approved WhatsApp template"
            value={selectedId}
            onChange={(e) => {
              setSelectedId(e.target.value);
              setManualValues({});
            }}
            className="bg-background h-8 w-full rounded-md border px-2 text-sm"
          >
            <option value="">Select an approved template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName}
              </option>
            ))}
          </select>
          {selected && (
            <>
              <p className="bg-muted/40 text-muted-foreground rounded-md p-2 text-xs whitespace-pre-wrap">
                {selected.body}
              </p>
              {manualVars.map((v) => (
                <Input
                  key={v.position}
                  aria-label={v.label}
                  placeholder={`${v.label} (e.g. ${v.sampleValue})`}
                  value={manualValues[v.position] ?? ""}
                  onChange={(e) =>
                    setManualValues((prev) => ({
                      ...prev,
                      [v.position]: e.target.value,
                    }))
                  }
                />
              ))}
              <div className="flex justify-end">
                <Button type="button" size="sm" onClick={send} disabled={sending}>
                  {sending ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileText className="mr-1 h-3.5 w-3.5" />
                  )}
                  Send template
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
