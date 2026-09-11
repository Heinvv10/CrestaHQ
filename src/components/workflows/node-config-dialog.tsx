"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePipelineStages } from "@/hooks/use-pipeline-stages";
import { NODE_LABELS } from "@/lib/workflows/catalog";
import { ConditionsEditor } from "./conditions-editor";
import type { BuilderStep } from "@/lib/workflows/builder-tree";
import type { ConditionGroup, NotifyRecipient } from "@/types/workflows";
import type { WhatsappTemplateVariable } from "@/types/whatsapp-templates";

type Cfg = Record<string, unknown>;

/** Approved WhatsApp template, loaded once and passed down for the picker. */
export interface WhatsappTemplateOption {
  id: string;
  displayName: string;
  body: string;
  variables: WhatsappTemplateVariable[];
  approved: boolean;
  /** A template with buttons can go out in-window without approval. */
  hasButtons: boolean;
}

/** One of the sub-account's WhatsApp senders, for the send-from picker. */
export interface WhatsappSenderOption {
  id: string;
  label: string;
  phoneNumber: string;
  isDefault: boolean;
}

function deriveWait(seconds: number): { value: number; unit: number } {
  if (seconds && seconds % 86_400 === 0)
    return { value: seconds / 86_400, unit: 86_400 };
  if (seconds && seconds % 3_600 === 0)
    return { value: seconds / 3_600, unit: 3_600 };
  return { value: Math.max(1, Math.round((seconds || 0) / 60)), unit: 60 };
}

export function NodeConfigDialog({
  step,
  whatsappTemplates,
  whatsappSenders,
  onClose,
  onSave,
}: {
  step: BuilderStep | null;
  whatsappTemplates: WhatsappTemplateOption[];
  whatsappSenders: WhatsappSenderOption[];
  onClose: () => void;
  onSave: (config: Cfg) => void;
}) {
  const [cfg, setCfg] = useState<Cfg>({});
  const stages = usePipelineStages();
  useEffect(() => {
    if (step) setCfg({ ...step.config });
  }, [step]);

  if (!step) return null;
  const set = (patch: Cfg) => setCfg((c) => ({ ...c, ...patch }));
  const defaultSender =
    whatsappSenders.find((s) => s.isDefault) ?? whatsappSenders[0] ?? null;
  const str = (k: string) => (cfg[k] as string) ?? "";
  // The template step always sends a template, so only approved ones. The
  // free-form step can also carry a button template in-window, unapproved.
  const approvedTemplates = whatsappTemplates.filter((t) => t.approved);
  const sendTemplates = whatsappTemplates.filter((t) => t.approved || t.hasButtons);

  const wait = deriveWait(Number(cfg.seconds ?? 86_400));
  // Legacy notify configs have no `recipient` — derive a sensible default so
  // they open showing the email they already have (else "Agency owner").
  const notifyRecipient: NotifyRecipient =
    (cfg.recipient as NotifyRecipient | undefined) ??
    (str("to").trim() ? "custom" : "owner");

  return (
    <Dialog open={!!step} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{NODE_LABELS[step.type]}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {step.type === "send_email" && (
            <>
              <Field label="Subject">
                <Input
                  value={str("subject")}
                  onChange={(e) => set({ subject: e.target.value })}
                />
              </Field>
              <Field
                label="Body"
                hint="Supports {{contact.firstName}} etc. Include {{unsubscribeLink}} for compliance."
              >
                <Textarea
                  rows={6}
                  value={str("body")}
                  onChange={(e) => set({ body: e.target.value })}
                />
              </Field>
            </>
          )}

          {step.type === "send_sms" && (
            <Field
              label="Message"
              hint="Supports merge tags like {{contact.firstName}}."
            >
              <Textarea
                rows={4}
                value={str("body")}
                onChange={(e) => set({ body: e.target.value })}
              />
            </Field>
          )}

          {step.type === "send_whatsapp" && (
            <>
              <Field
                label="Message"
                hint="Sent as free-form text whenever that is allowed — which is free. Supports merge tags like {{contact.firstName}}."
              >
                <Textarea
                  rows={4}
                  value={str("body")}
                  onChange={(e) => set({ body: e.target.value })}
                />
              </Field>
              <Field
                label="Template — its buttons, or the fallback when the window has closed"
                hint={
                  sendTemplates.length === 0
                    ? "No approved templates yet. Without one this step is skipped when the window is shut — which is correct for a step that only ever replies to a contact who just messaged."
                    : "Meta only allows free-form text within 24 hours of the contact's last message. Pick an approved template to re-open a closed window, or leave this empty to skip the step instead of paying template rates. A template with buttons is sent WITH them inside the window (its own text, free, no approval needed); outside it, it needs approval or the step is skipped."
                }
              >
                <select
                  value={str("templateId")}
                  onChange={(e) =>
                    set({ templateId: e.target.value, manualValues: {} })
                  }
                  className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
                >
                  <option value="">
                    Skip the step (no template fallback)
                  </option>
                  {sendTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.displayName}
                      {t.approved ? "" : " — buttons, in-window only"}
                    </option>
                  ))}
                </select>
              </Field>
              {(() => {
                // A fallback template's variables still have to be filled in.
                // Without these inputs `manualValues` is unreachable from the
                // UI, and Meta receives a template with empty parameters.
                const tpl =
                  sendTemplates.find((t) => t.id === str("templateId")) ??
                  null;
                if (!tpl) return null;
                const manualValues =
                  (cfg.manualValues as Record<string, string> | undefined) ?? {};
                const mergeVars = tpl.variables.filter(
                  (v) => v.source === "merge_tag",
                );
                const manualVars = tpl.variables.filter(
                  (v) => v.source === "manual",
                );
                return (
                  <>
                    <div className="bg-muted/30 text-muted-foreground rounded-md border p-2 text-xs whitespace-pre-wrap">
                      {tpl.body}
                    </div>
                    {mergeVars.length > 0 && (
                      <p className="text-muted-foreground text-xs">
                        Auto-filled from the contact:{" "}
                        {mergeVars
                          .map((v) => `{{${v.position}}} ${v.label}`)
                          .join(", ")}
                        .
                      </p>
                    )}
                    {manualVars.map((v) => (
                      <Field
                        key={v.position}
                        label={`Variable {{${v.position}}} — ${v.label}`}
                        hint="Static text, or merge tags like {{contact.firstName}}."
                      >
                        <Input
                          value={manualValues[String(v.position)] ?? ""}
                          placeholder={v.sampleValue}
                          onChange={(e) =>
                            set({
                              manualValues: {
                                ...manualValues,
                                [v.position]: e.target.value,
                              },
                            })
                          }
                        />
                      </Field>
                    ))}
                  </>
                );
              })()}
            </>
          )}

          {step.type === "whatsapp_template" && (
            <Field
              label="Send from"
              hint="Leave on the account default unless this step has to go out on a particular number."
            >
              <select
                value={str("senderId")}
                onChange={(e) => set({ senderId: e.target.value })}
                className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
              >
                {/* Empty value, not the default sender's id: a step that says
                    "the account default" must follow the default when it
                    changes, rather than pinning the number it had today. */}
                <option value="">
                  Account default
                  {defaultSender ? ` — ${defaultSender.label}` : ""}
                </option>
                {whatsappSenders.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                    {s.phoneNumber ? ` — ${s.phoneNumber}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {step.type === "whatsapp_template" &&
            (() => {
              const tplId = str("templateId");
              const tpl = approvedTemplates.find((t) => t.id === tplId) ?? null;
              const manualValues =
                (cfg.manualValues as Record<string, string> | undefined) ?? {};
              const mergeVars =
                tpl?.variables.filter((v) => v.source === "merge_tag") ?? [];
              const manualVars =
                tpl?.variables.filter((v) => v.source === "manual") ?? [];
              return (
                <>
                  <Field
                    label="Template"
                    hint={
                      approvedTemplates.length === 0
                        ? "No approved WhatsApp templates yet. Create one in AI Agents → WhatsApp → Templates."
                        : "Only Meta-approved templates can be sent on WhatsApp."
                    }
                  >
                    <select
                      value={tplId}
                      onChange={(e) =>
                        set({ templateId: e.target.value, manualValues: {} })
                      }
                      className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
                    >
                      <option value="">Choose a template…</option>
                      {approvedTemplates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.displayName}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {tpl && (
                    <div className="bg-muted/30 text-muted-foreground rounded-md border p-2 text-xs whitespace-pre-wrap">
                      {tpl.body}
                    </div>
                  )}
                  {mergeVars.length > 0 && (
                    <p className="text-muted-foreground text-xs">
                      Auto-filled from the contact:{" "}
                      {mergeVars
                        .map((v) => `{{${v.position}}} ${v.label}`)
                        .join(", ")}
                      .
                    </p>
                  )}
                  {manualVars.map((v) => (
                    <Field
                      key={v.position}
                      label={`Variable {{${v.position}}} — ${v.label}`}
                      hint="Static text, or merge tags like {{contact.firstName}}."
                    >
                      <Input
                        value={manualValues[String(v.position)] ?? ""}
                        placeholder={v.sampleValue}
                        onChange={(e) =>
                          set({
                            manualValues: {
                              ...manualValues,
                              [v.position]: e.target.value,
                            },
                          })
                        }
                      />
                    </Field>
                  ))}
                </>
              );
            })()}

          {step.type === "wait" && (
            <Field label="Wait for">
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  className="w-24"
                  value={wait.value}
                  onChange={(e) =>
                    set({
                      seconds: Math.max(1, Number(e.target.value)) * wait.unit,
                    })
                  }
                />
                <select
                  value={wait.unit}
                  onChange={(e) =>
                    set({ seconds: wait.value * Number(e.target.value) })
                  }
                  className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                >
                  <option value={60}>minutes</option>
                  <option value={3_600}>hours</option>
                  <option value={86_400}>days</option>
                </select>
              </div>
            </Field>
          )}

          {step.type === "wait_for_reply" && (
            <>
              <Field label="Wait for a reply for up to">
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    className="w-24"
                    value={wait.value}
                    onChange={(e) =>
                      set({
                        seconds:
                          Math.max(1, Number(e.target.value)) * wait.unit,
                      })
                    }
                  />
                  <select
                    value={wait.unit}
                    onChange={(e) =>
                      set({ seconds: wait.value * Number(e.target.value) })
                    }
                    className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                  >
                    <option value={60}>minutes</option>
                    <option value={3_600}>hours</option>
                    <option value={86_400}>days</option>
                  </select>
                </div>
              </Field>
              <p className="text-muted-foreground text-xs">
                If the contact replies within this window, the workflow
                continues down the <strong>Replied</strong> branch right away;
                otherwise it takes the <strong>No reply</strong> branch when
                the window ends. Counts SMS, WhatsApp, and Facebook/Instagram
                replies — email replies go straight to your own inbox and
                can&apos;t be detected.
              </p>
            </>
          )}

          {step.type === "if_else" && (
            <Field label="Continue down “yes” when:">
              <ConditionsEditor
                allowReplyField
                value={(cfg.conditions as ConditionGroup) ?? { all: [] }}
                onChange={(g) => set({ conditions: g })}
              />
            </Field>
          )}

          {(step.type === "add_tag" || step.type === "remove_tag") && (
            <Field label="Tag">
              <Input
                value={str("tag")}
                onChange={(e) => set({ tag: e.target.value })}
              />
            </Field>
          )}

          {step.type === "move_stage" && (
            <Field label="Move contact to stage">
              <select
                value={str("stage") || "new"}
                onChange={(e) => set({ stage: e.target.value })}
                className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {step.type === "update_field" && (
            <>
              <Field
                label="Field"
                hint="A contact field (e.g. company) or customFields.yourKey"
              >
                <Input
                  value={str("field")}
                  onChange={(e) => set({ field: e.target.value })}
                />
              </Field>
              <Field label="Value">
                <Input
                  value={str("value")}
                  onChange={(e) => set({ value: e.target.value })}
                />
              </Field>
            </>
          )}

          {step.type === "create_task" && (
            <>
              <Field label="Task title" hint="Supports merge tags.">
                <Input
                  value={str("title")}
                  onChange={(e) => set({ title: e.target.value })}
                />
              </Field>
              <Field label="Due in (days)">
                <Input
                  type="number"
                  min={0}
                  className="w-28"
                  value={Number(cfg.dueInDays ?? 1)}
                  onChange={(e) => set({ dueInDays: Number(e.target.value) })}
                />
              </Field>
            </>
          )}

          {step.type === "notify" && (
            <>
              <Field
                label="Send to"
                hint={
                  notifyRecipient === "account_contact"
                    ? "This sub-account's primary contact (Settings → Admin → Account contact). Falls back to the agency owner if none is set."
                    : notifyRecipient === "owner"
                      ? "Notifies the agency owner."
                      : undefined
                }
              >
                <select
                  value={notifyRecipient}
                  onChange={(e) =>
                    set({ recipient: e.target.value as NotifyRecipient })
                  }
                  className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
                >
                  <option value="owner">Agency owner</option>
                  <option value="account_contact">Account contact</option>
                  <option value="custom">Custom email</option>
                </select>
              </Field>
              {notifyRecipient === "custom" && (
                <Field label="Email address">
                  <Input
                    value={str("to")}
                    placeholder="name@example.com"
                    onChange={(e) => set({ to: e.target.value })}
                  />
                </Field>
              )}
              <Field label="Subject">
                <Input
                  value={str("subject")}
                  onChange={(e) => set({ subject: e.target.value })}
                />
              </Field>
              <Field label="Body">
                <Textarea
                  rows={4}
                  value={str("body")}
                  onChange={(e) => set({ body: e.target.value })}
                />
              </Field>
            </>
          )}

          {step.type === "webhook" && (
            <Field label="POST URL">
              <Input
                value={str("url")}
                placeholder="https://…"
                onChange={(e) => set({ url: e.target.value })}
              />
            </Field>
          )}

          {step.type === "goal" && (
            <p className="text-muted-foreground text-sm">
              This step ends the workflow — nothing runs after it on this path.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onSave(cfg);
              onClose();
            }}
          >
            Save step
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}
