import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendEmail, emailIsConfigured, tenantFrom } from "@/lib/comms/resend";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import { dispatchWhatsappTemplateSend } from "@/lib/comms/whatsapp/template-dispatch";
import { dispatchWhatsappSend } from "@/lib/comms/whatsapp/send-dispatch";
import { checkWhatsappReadiness } from "@/lib/comms/whatsapp/readiness";
import { isTemplateApprovedFor } from "@/lib/comms/whatsapp/template-registrations";
import { capabilitiesFor } from "@/lib/comms/whatsapp/provider";
import {
  sendSmsForSubAccount,
  sendWhatsappForSubAccount,
  sendWhatsappTemplateForSubAccount,
  smsIsConfigured,
  subAccountTwilioIsConfigured,
  SmsRecipientUnsubscribedError,
} from "@/lib/comms/twilio";
import { agencyAllowsSharedSms } from "@/lib/agency/policy";
import { resolveTemplateVariables } from "@/lib/comms/whatsapp/resolve-template-variables";
import {
  interactiveFromButtons,
  type InteractiveResult,
} from "@/lib/comms/whatsapp/interactive";
import { ensureTwilioSessionContent } from "@/lib/comms/whatsapp/twilio-session-content";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { checkQuota, UsageQuotaExceededError } from "@/lib/server/usage-meter";
import { reconcileEnrolments } from "@/lib/api/enrolment-cap";
import {
  resolveMergeTags,
  type MergeTagSubject,
} from "@/lib/automations/merge-tags";
import { buildUnsubscribeUrl } from "@/lib/automations/unsubscribe-token";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import { evalConditionGroup } from "./conditions";
import type { Contact } from "@/types/contacts";
import type { AgencyDoc, SubAccountDoc } from "@/types";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";
import type { CloudTemplateRef } from "@/lib/comms/whatsapp/cloud-client";
import type {
  CreateTaskConfig,
  IfElseConfig,
  MoveStageConfig,
  NotifyConfig,
  SendEmailConfig,
  SendSmsConfig,
  SendWhatsappConfig,
  TagConfig,
  WhatsappTemplateConfig,
  UpdateFieldConfig,
  WaitConfig,
  WaitForReplyConfig,
  WebhookConfig,
  WorkflowDoc,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowRunDoc,
  WorkflowRunHistoryEntry,
  WorkflowTriggerType,
} from "@/types/workflows";

const STEP_PATH = "/api/workflows/step";

/* --------------------------- Node executors ---------------------------- */

export type StepResult =
  | { kind: "next" }
  | { kind: "wait"; seconds: number }
  | { kind: "branch"; value: boolean }
  | { kind: "end" };

interface NodeContext {
  node: WorkflowNode;
  contact: Contact;
  subAccount: SubAccountDoc | null;
  owner: { displayName: string; email: string };
  subAccountId: string;
  agencyId: string;
  /** Workflow author — stamped on writes (tasks) for audit. */
  createdByUid: string;
  /** The run this step belongs to — stamped on the contact-timeline rows the
   *  engine writes so the Activity tab can link to the run history. */
  workflowId: string;
  runId: string;
  /**
   * The trigger context captured at enrollment (e.g. the submitted form's
   * answers under `formData`). Carried on the run doc; surfaced here so the
   * Webhook step can forward the form fields downstream.
   */
  triggerContext: Record<string, unknown>;
}

/** An executor returns the control-flow result + a short audit log string. */
type NodeExecutor = (
  ctx: NodeContext
) => Promise<{ result: StepResult; log: string }>;

function mergeSubject(
  ctx: NodeContext,
  unsubscribeLink: string
): MergeTagSubject {
  return {
    contact: {
      name: ctx.contact.name,
      email: ctx.contact.email,
      phone: ctx.contact.phone,
      customFields: ctx.contact.customFields ?? null,
    },
    owner: ctx.owner,
    workspace: { name: ctx.subAccount?.name ?? "" },
    bookingLink: ctx.subAccount?.bookingLink ?? "",
    unsubscribeLink,
  };
}

const execSendEmail: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as SendEmailConfig;
  const contact = ctx.contact;
  if (contact.emailOptedOut)
    return { result: { kind: "next" }, log: "skipped:opt_out" };
  const to = contact.email;
  if (!to) return { result: { kind: "next" }, log: "skipped:no_email" };
  if (!emailIsConfigured(ctx.subAccount)) {
    return { result: { kind: "next" }, log: "error:email_not_configured" };
  }

  // Monthly email quota (Usage Metering v1). Fails open.
  const emailQuota = await checkQuota({
    subAccountId: ctx.subAccountId,
    unit: "emailsSent",
    subAccount: ctx.subAccount,
  });
  if (!emailQuota.allowed) {
    return { result: { kind: "next" }, log: "skipped:quota" };
  }

  const unsubscribeLink = buildUnsubscribeUrl(contact.id);
  const subject = resolveMergeTags(
    cfg.subject ?? "",
    mergeSubject(ctx, unsubscribeLink)
  );
  const text = resolveMergeTags(
    cfg.body ?? "",
    mergeSubject(ctx, unsubscribeLink)
  );
  // HTML render: substituted values are escaped (a contact's name or a
  // custom field set over the public API is untrusted free text), but the
  // unsubscribe anchor we supply ourselves must stay real markup.
  const htmlInner = resolveMergeTags(
    cfg.body ?? "",
    mergeSubject(ctx, `<a href="${unsubscribeLink}">Unsubscribe</a>`),
    { escape: "html", safeTags: ["unsubscribeLink"] }
  ).replace(/\r?\n/g, "<br>");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px;">${htmlInner}</body></html>`;

  try {
    const { id: messageId } = await sendEmail({
      contactId: contact.id,
      to,
      subject: subject || "(no subject)",
      text,
      html,
      replyTo: ctx.subAccount?.replyToEmail ?? undefined,
      from: tenantFrom(ctx.subAccount),
      subAccount: ctx.subAccount,
      meter: { subAccountId: ctx.subAccountId },
    });
    // Trace on the CONTACT, not just the run history — an automation that
    // emails a customer must be visible from the record the operator opens.
    try {
      await getAdminDb()
        .collection("contacts")
        .doc(contact.id)
        .collection("activities")
        .add({
          type: "email_sent",
          content: `Email (workflow): ${subject || "(no subject)"}`,
          createdBy: "workflow",
          meta: {
            messageId,
            subject: subject || "(no subject)",
            workflowId: ctx.workflowId,
            runId: ctx.runId,
          },
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn("[workflows] email activity write failed", err);
    }
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "send_failed"}`,
    };
  }
};

const execSendSms: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as SendSmsConfig;
  const contact = ctx.contact;
  if (smsSendBlock(contact))
    return { result: { kind: "next" }, log: "skipped:opt_out" };
  const to = contact.phone;
  if (!to) return { result: { kind: "next" }, log: "skipped:no_phone" };
  // Send via the sub-account's dedicated Twilio when configured, else the
  // shared env creds — same resolution the contact-profile SMS uses. The shared
  // fallback only counts when the agency still permits it.
  const hasSms =
    subAccountTwilioIsConfigured(ctx.subAccount?.twilioConfig) ||
    (smsIsConfigured() &&
      (await agencyAllowsSharedSms(ctx.subAccount?.agencyId)));
  if (!hasSms) {
    return { result: { kind: "next" }, log: "error:sms_not_configured" };
  }
  const body = resolveMergeTags(cfg.body ?? "", mergeSubject(ctx, ""));
  try {
    const sent = await sendSmsForSubAccount({
      subAccountId: ctx.subAccountId,
      subAccount: ctx.subAccount,
      to,
      body,
    });
    // Trace on the contact + unified inbox, mirroring the manual send
    // route. Thread/inbox rows only in dedicated mode: on the shared agency
    // number the inbound webhook can't resolve a sub-account, so a reply
    // could never be attributed — writing a thread there would promise a
    // two-way channel that can't exist. Shared-mode sends get the activity
    // and not the thread.
    const preview = body.length > 80 ? `${body.slice(0, 80)}…` : body;
    const db = getAdminDb();
    try {
      await db
        .collection("contacts")
        .doc(contact.id)
        .collection("activities")
        .add({
          type: "sms_sent",
          content: `SMS (workflow): ${preview}`,
          createdBy: "workflow",
          meta: {
            sid: sent.sid,
            mode: sent.mode,
            workflowId: ctx.workflowId,
            runId: ctx.runId,
          },
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn("[workflows] sms activity write failed", err);
    }
    if (sent.mode === "dedicated") {
      try {
        await db
          .collection("contacts")
          .doc(contact.id)
          .collection("messages")
          .doc(sent.sid)
          .set({
            agencyId: ctx.agencyId,
            subAccountId: ctx.subAccountId,
            contactId: contact.id,
            direction: "outbound",
            status: "sent",
            body,
            from: sent.from,
            to,
            twilioMessageSid: sent.sid,
            sentByUid: "workflow",
            error: null,
            readAt: null,
            createdAt: FieldValue.serverTimestamp(),
          });
        // Dynamic import: conversations-service statically imports this
        // engine (resumeWaitingRunsOnReply), so a static import back would
        // be a cycle. pauseBot false — an automated nudge is not a human
        // takeover; the AI should still answer the reply it invites.
        const { upsertConversationForMessage } = await import(
          "@/lib/server/conversations-service"
        );
        await upsertConversationForMessage({
          contactId: contact.id,
          subAccountId: ctx.subAccountId,
          agencyId: ctx.agencyId,
          contactName: contact.name ?? "",
          contactPhone: to,
          channel: "sms",
          direction: "outbound",
          body,
          pauseBot: false,
        });
      } catch (err) {
        console.warn("[workflows] sms thread/inbox write failed", err);
      }
    }
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    if (err instanceof UsageQuotaExceededError) {
      return { result: { kind: "next" }, log: "skipped:quota" };
    }
    if (err instanceof SmsRecipientUnsubscribedError) {
      // The carrier says this number texted STOP (possibly before it was
      // wired to our webhook). Record it so the run history explains the
      // failure AND every later send is blocked up front.
      try {
        const db = getAdminDb();
        await db.doc(`contacts/${contact.id}`).update({
          smsOptedOut: true,
          updatedAt: FieldValue.serverTimestamp(),
        });
        await db
          .collection("contacts")
          .doc(contact.id)
          .collection("activities")
          .add({
            type: "automation_step_skipped",
            content: `SMS refused by carrier — ${to} is unsubscribed (Twilio 21610).`,
            createdBy: "workflow",
            meta: {
              kind: "sms_opt_out",
              word: "21610",
              optedOut: true,
              workflowId: ctx.workflowId,
              runId: ctx.runId,
            },
            createdAt: FieldValue.serverTimestamp(),
          });
      } catch (recordErr) {
        console.warn("[workflows] 21610 opt-out record failed", recordErr);
      }
      return { result: { kind: "next" }, log: "error:carrier_unsubscribed" };
    }
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "send_failed"}`,
    };
  }
};

/** Exported for tests only — the registry below is the production entry point.
 *  The one seam where readiness, template approval and dispatch have to agree
 *  on the sender has no other place to be asserted from. */
export const execWhatsappTemplate: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as WhatsappTemplateConfig;
  const contact = ctx.contact;
  if (contact.whatsappOptedOut)
    return { result: { kind: "next" }, log: "skipped:opt_out" };
  const to = contact.phone;
  if (!to) return { result: { kind: "next" }, log: "skipped:no_phone" };
  // Requires the agency WhatsApp gate AND a configured WhatsApp sender. The
  // builder surfaces this as a red node, but re-check here in case the gate
  // flipped off after the workflow was built.
  if (ctx.subAccount?.whatsappEnabledByAgency !== true) {
    return { result: { kind: "next" }, log: "error:whatsapp_not_configured" };
  }
  // Per-rail, and it must agree with the builder's red-node readiness or the
  // builder promises a step the run then skips. The old Twilio-shaped check
  // refused Cloud, whose templates dispatchWhatsappTemplateSend supports.
  const tplReadiness = await checkWhatsappReadiness({
    subAccountId: ctx.subAccountId,
    subAccount: ctx.subAccount ?? null,
    senderId: cfg.senderId,
  });
  if (!tplReadiness.ready) {
    return { result: { kind: "next" }, log: "error:whatsapp_not_configured" };
  }
  // The bridge has no templates at all; its own dispatcher refuses, but
  // skipping here keeps the log honest about WHY rather than surfacing a send
  // failure for a step that could never run.
  if (!capabilitiesFor(tplReadiness.provider).supportsTemplates) {
    return { result: { kind: "next" }, log: "skipped:rail_has_no_templates" };
  }
  if (!cfg.templateId)
    return { result: { kind: "next" }, log: "skipped:no_template" };

  const tplSnap = await getAdminDb()
    .doc(`subAccounts/${ctx.subAccountId}/whatsappTemplates/${cfg.templateId}`)
    .get();
  const tpl = tplSnap.exists ? (tplSnap.data() as WhatsappTemplateDoc) : null;
  // Approval is per rail — a template cleared on Twilio has never been seen by
  // our own WABA. Checking the flat fields would pass a template approved on
  // the rail this workspace no longer uses.
  // The rail READINESS resolved, not a second resolution of its own: asking
  // twice is how a step gets admitted on one rail and refused on another.
  if (!tpl || !isTemplateApprovedFor(tpl, tplReadiness.provider)) {
    // Deleted, never approved on this rail, or approval lost (paused/disabled).
    return { result: { kind: "next" }, log: "error:template_not_approved" };
  }

  const subject = mergeSubject(ctx, "");
  // Operator-set MANUAL variable values may contain merge tags — resolve them
  // against the contact before handing to the positional resolver.
  const manualValues: Record<number, string> = {};
  for (const [pos, val] of Object.entries(cfg.manualValues ?? {})) {
    manualValues[Number(pos)] = resolveMergeTags(val ?? "", subject);
  }
  const contentVariables = resolveTemplateVariables({
    variables: tpl.variables,
    subject,
    manualValues,
  });

  try {
    // Through the provider dispatcher, not Twilio directly: a workspace on the
    // Cloud rail would otherwise fail this step with "WhatsApp is not
    // configured" and log it as a generic send error.
    const res = await dispatchWhatsappTemplateSend({
      subAccountId: ctx.subAccountId,
      subAccount: ctx.subAccount,
      to,
      template: tpl,
      values: contentVariables,
      senderId: cfg.senderId,
      sendViaTwilio: async (contentSid) => {
        const r = await sendWhatsappTemplateForSubAccount({
          subAccountId: ctx.subAccountId,
          subAccount: ctx.subAccount,
          to,
          contentSid,
          contentVariables,
        });
        return { ok: true, messageId: r.sid };
      },
    });
    if (!res.ok) {
      return {
        result: { kind: "next" },
        log: `error:${res.error ?? "send_failed"}`,
      };
    }
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    if (err instanceof UsageQuotaExceededError) {
      return { result: { kind: "next" }, log: "skipped:quota" };
    }
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "send_failed"}`,
    };
  }
};

/**
 * Free-form WhatsApp, template only as the closed-window fallback.
 *
 * The difference from `execWhatsappTemplate` is where the send mode is decided.
 * That node always sends a template, so it bills at template rates even when
 * the contact's service window is open and text would be free — the recurring
 * cost `docs/PARITY_PLAN.md` traced to the review-ask step. Here the decision
 * belongs to `dispatchWhatsappSend`, which calls the one shared window rule,
 * so a step that fires just after a customer replies costs nothing.
 *
 * It is also the node a `bridge` workspace uses: the rail has no templates, and
 * `resolveWaSendMode` returns text mode for it by declared capability rather
 * than by special case. `checkWhatsappReadiness` now resolves the bridge for
 * real — credentials plus a live health probe — so this node runs there.
 *
 * Readiness goes through `checkWhatsappReadiness` rather than the Twilio-shaped
 * credential check, which would refuse a correctly configured Cloud or bridge
 * workspace.
 */
/** Exported for tests only — the registry below is the production entry point.
 *  Its template-variable resolution has no other seam to assert against. */
export const execSendWhatsapp: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as SendWhatsappConfig;
  const contact = ctx.contact;
  if (contact.whatsappOptedOut)
    return { result: { kind: "next" }, log: "skipped:opt_out" };
  const to = contact.phone;
  if (!to) return { result: { kind: "next" }, log: "skipped:no_phone" };
  if (ctx.subAccount?.whatsappEnabledByAgency !== true) {
    return { result: { kind: "next" }, log: "error:whatsapp_not_configured" };
  }
  const readiness = await checkWhatsappReadiness({
    subAccountId: ctx.subAccountId,
    subAccount: ctx.subAccount,
  });
  if (!readiness.ready) {
    return { result: { kind: "next" }, log: "error:whatsapp_not_configured" };
  }

  const subject = mergeSubject(ctx, "");
  const body = resolveMergeTags(cfg.body ?? "", subject);

  // The template is optional. A step that only ever fires inside an open
  // window needs none — and needs no Meta approval to ship.
  let template: CloudTemplateRef | null = null;
  let inWindowButtons: InteractiveResult | null = null;
  let templateValues: string[] = [];
  let templateBody = "";
  let tplDoc: WhatsappTemplateDoc | null = null;
  if (cfg.templateId) {
    const tplSnap = await getAdminDb()
      .doc(`subAccounts/${ctx.subAccountId}/whatsappTemplates/${cfg.templateId}`)
      .get();
    tplDoc = tplSnap.exists ? (tplSnap.data() as WhatsappTemplateDoc) : null;
  }
  if (tplDoc) {
    // The variables have to be resolved here, exactly as execWhatsappTemplate
    // does. Meta fills a template's {{1}}, {{2}} from the `parameters` list;
    // sending an empty `components` for a template that declares variables
    // is a 400 from Graph, or worse, a message with visible placeholders
    // reaching the customer. `merge_tag` variables resolve from the contact;
    // MANUAL ones are operator-set strings that may themselves carry tags.
    const manualValues: Record<number, string> = {};
    for (const [pos, val] of Object.entries(cfg.manualValues ?? {})) {
      manualValues[Number(pos)] = resolveMergeTags(val ?? "", subject);
    }
    const values = resolveTemplateVariables({
      variables: tplDoc.variables ?? [],
      subject,
      manualValues,
    });
    templateValues = values;
    templateBody = (tplDoc.body ?? "").replace(
      /\{\{\s*(\d+)\s*\}\}/g,
      (_match, position: string) => values[Number(position) - 1] ?? "",
    );
    // A template with buttons goes out WITH them inside the window, as a
    // free interactive message that needs no approval — how the review link
    // rides behind a "Leave a review" button without becoming a paid,
    // likely-MARKETING template send. Its text is the template's, since the
    // buttons belong to it. Whether they CAN be rendered in-window is decided
    // by the dispatcher once the window is known: outside it an approved
    // template goes as itself, whatever its buttons.
    if (tplDoc.buttons?.length) {
      // An in-window button message with a blank variable is refused: Cloud
      // would send "Thank you !", and Twilio may substitute the template's
      // SAMPLE value — a stranger's name — to a real customer. (Out-of-window
      // template sends are unchanged; that rule is gap 5b.)
      inWindowButtons = values.some((v) => !v.trim())
        ? { ok: false, error: "WA_TEMPLATE_VARIABLE_EMPTY" }
        : interactiveFromButtons(templateBody, tplDoc.buttons);
    }
    // Approval is per rail, as in execWhatsappTemplate: a template cleared on
    // Twilio has never been seen by our own WABA. The rail is the one
    // readiness resolved, so this check and the dispatcher below agree.
    if (isTemplateApprovedFor(tplDoc, readiness.provider)) {
      template = {
        name: tplDoc.name,
        language: tplDoc.language ?? "en",
        components: values.length
          ? [
              {
                type: "body",
                parameters: values.map((text) => ({ type: "text", text })),
              },
            ]
          : [],
        approved: true,
      };
    }
  }
  if (!body.trim() && !inWindowButtons)
    return { result: { kind: "next" }, log: "skipped:empty_body" };

  try {
    const res = await dispatchWhatsappSend({
      subAccountId: ctx.subAccountId,
      subAccount: ctx.subAccount,
      contactId: contact.id,
      to,
      body,
      template,
      inWindowButtons,
      // Twilio sends in-session buttons only by ContentSid: an unapproved
      // Content resource per template, cached on the doc.
      sendButtonsViaTwilio:
        tplDoc && cfg.templateId && ctx.subAccount?.twilioConfig
          ? async () => {
              const contentSid = await ensureTwilioSessionContent({
                subAccountId: ctx.subAccountId,
                templateId: cfg.templateId!,
                template: tplDoc!,
                accountSid: ctx.subAccount!.twilioConfig!.accountSid,
                authToken: ctx.subAccount!.twilioConfig!.authToken,
              });
              const r = await sendWhatsappTemplateForSubAccount({
                subAccountId: ctx.subAccountId,
                subAccount: ctx.subAccount,
                to,
                contentSid,
                contentVariables: templateValues,
              });
              return { ok: true, messageId: r.sid };
            }
          : undefined,
      sendViaTwilio: async () => {
        const r = await sendWhatsappForSubAccount({
          subAccountId: ctx.subAccountId,
          subAccount: ctx.subAccount,
          to,
          body,
        });
        return { ok: true, messageId: r.sid };
      },
    });
    if (!res.ok) {
      return {
        result: { kind: "next" },
        log: `error:${res.error ?? "send_failed"}`,
      };
    }
    // A successful provider call does not write the CRM thread. Use the same
    // provider message id as the manual composer so the row is addressable.
    // Keep recording failures distinct: the message has already been sent.
    const recordedBody =
      res.sentAs === "template" || res.sentAs === "interactive" ? templateBody : body;
    try {
      const messages = getAdminDb().collection(`contacts/${contact.id}/whatsappMessages`);
      const messageRef = res.messageId ? messages.doc(res.messageId) : messages.doc();
      await messageRef.set({
          agencyId: ctx.agencyId,
          subAccountId: ctx.subAccountId,
          contactId: contact.id,
          direction: "outbound",
          status: "sent",
          body: recordedBody,
          from: readiness.sender.phoneNumber,
          to,
          twilioMessageSid: res.messageId ?? null,
          sentByUid: null,
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn("[workflows] WhatsApp message-row write failed", err);
      return { result: { kind: "next" }, log: "sent:message_record_failed" };
    }
    await upsertConversationForMessage({
      contactId: contact.id,
      subAccountId: ctx.subAccountId,
      agencyId: ctx.agencyId,
      contactName: contact.name ?? "",
      contactPhone: to,
      channel: "whatsapp",
      direction: "outbound",
      body: recordedBody,
    });
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    if (err instanceof UsageQuotaExceededError) {
      return { result: { kind: "next" }, log: "skipped:quota" };
    }
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "send_failed"}`,
    };
  }
};

const execWait: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as WaitConfig;
  const seconds = Math.max(0, Math.floor(cfg.seconds ?? 0));
  return { result: { kind: "wait", seconds }, log: `wait:${seconds}s` };
};

/** Enough for a button payload or a short free-text answer; short enough that
 *  carrying it on the run doc costs nothing. */
const REPLY_TEXT_MAX = 500;

/** Exported for tests only — the registry is the production entry point. */
export const execIfElse: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as IfElseConfig;
  // The reply that resumed an upstream wait_for_reply, if there was one. It
  // rides run.context (surfaced here as triggerContext) rather than the
  // contact, because it is per-run: the same contact can be mid-flight in two
  // runs that are branching on different answers.
  const lastReply = ctx.triggerContext?.lastReply as
    | { text?: string }
    | undefined;
  const pass = evalConditionGroup(cfg.conditions, ctx.contact, {
    replyText: lastReply?.text ?? null,
  });
  return { result: { kind: "branch", value: pass }, log: `branch:${pass}` };
};

const execGoal: NodeExecutor = async () => ({
  result: { kind: "end" },
  log: "goal",
});

const execAddTag: NodeExecutor = async (ctx) => {
  const tag = ((ctx.node.config as unknown as TagConfig).tag ?? "").trim();
  if (!tag) return { result: { kind: "next" }, log: "skipped:no_tag" };
  await getAdminDb()
    .doc(`contacts/${ctx.contact.id}`)
    .update({
      tags: FieldValue.arrayUnion(tag),
      updatedAt: FieldValue.serverTimestamp(),
    });
  return { result: { kind: "next" }, log: `tag+:${tag}` };
};

const execRemoveTag: NodeExecutor = async (ctx) => {
  const tag = ((ctx.node.config as unknown as TagConfig).tag ?? "").trim();
  if (!tag) return { result: { kind: "next" }, log: "skipped:no_tag" };
  await getAdminDb()
    .doc(`contacts/${ctx.contact.id}`)
    .update({
      tags: FieldValue.arrayRemove(tag),
      updatedAt: FieldValue.serverTimestamp(),
    });
  return { result: { kind: "next" }, log: `tag-:${tag}` };
};

const execMoveStage: NodeExecutor = async (ctx) => {
  const stage = (
    (ctx.node.config as unknown as MoveStageConfig).stage ?? ""
  ).trim();
  if (!stage) return { result: { kind: "next" }, log: "skipped:no_stage" };
  await getAdminDb()
    .doc(`contacts/${ctx.contact.id}`)
    .update({ pipelineStage: stage, updatedAt: FieldValue.serverTimestamp() });
  return { result: { kind: "next" }, log: `stage:${stage}` };
};

// Only these top-level contact fields may be set by a workflow — prevents a
// crafted config from clobbering tenancy/system keys. customFields.* is open.
const WRITABLE_FIELDS = new Set([
  "name",
  "email",
  "phone",
  "company",
  "source",
  "pipelineStage",
]);

const execUpdateField: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as UpdateFieldConfig;
  const field = (cfg.field ?? "").trim();
  if (!field) return { result: { kind: "next" }, log: "skipped:no_field" };
  if (!field.startsWith("customFields.") && !WRITABLE_FIELDS.has(field)) {
    return { result: { kind: "next" }, log: "skipped:field_not_writable" };
  }
  await getAdminDb()
    .doc(`contacts/${ctx.contact.id}`)
    .update({
      [field]: cfg.value ?? "",
      updatedAt: FieldValue.serverTimestamp(),
    });
  return { result: { kind: "next" }, log: `field:${field}` };
};

const execCreateTask: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as CreateTaskConfig;
  const title =
    resolveMergeTags(cfg.title ?? "Follow up", mergeSubject(ctx, "")) ||
    "Follow up";
  const dueAt =
    cfg.dueInDays && cfg.dueInDays > 0
      ? new Date(Date.now() + cfg.dueInDays * 86_400_000)
      : null;
  await createTaskServerSide({
    subAccountId: ctx.subAccountId,
    agencyId: ctx.agencyId,
    createdByUid: ctx.createdByUid,
    mode: "live",
    title,
    notes: "Created by workflow",
    dueAt,
    contactId: ctx.contact.id,
    dealId: null,
    eventId: null,
    workflow: { workflowId: ctx.workflowId, runId: ctx.runId },
  });
  return { result: { kind: "next" }, log: "task_created" };
};

/**
 * Resolve who an Internal notification emails. "account_contact" reads the
 * sub-account's primary contact (Settings → Admin → Account contact); a custom
 * email is used as typed. The agency owner is the ultimate fallback so a
 * notification is never silently dropped — including when "account_contact" is
 * chosen but that contact has no email set.
 */
function resolveNotifyTo(cfg: NotifyConfig, ctx: NodeContext): string {
  const owner = ctx.owner.email;
  switch (cfg.recipient) {
    case "owner":
      return owner;
    case "account_contact":
      return ctx.subAccount?.accountContact?.email?.trim() || owner;
    // "custom" and legacy (undefined) both use the typed email, else owner.
    default:
      return (cfg.to ?? "").trim() || owner;
  }
}

const execNotify: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as NotifyConfig;
  const to = resolveNotifyTo(cfg, ctx);
  if (!to) return { result: { kind: "next" }, log: "skipped:no_recipient" };
  if (!emailIsConfigured(ctx.subAccount)) {
    return { result: { kind: "next" }, log: "error:email_not_configured" };
  }
  const subject = resolveMergeTags(
    cfg.subject ?? "Workflow notification",
    mergeSubject(ctx, "")
  );
  const text = resolveMergeTags(cfg.body ?? "", mergeSubject(ctx, ""));
  // Separate render for HTML — the plain-text one interpolates contact
  // values raw, which is correct for text and unsafe for markup.
  const htmlInner = resolveMergeTags(cfg.body ?? "", mergeSubject(ctx, ""), {
    escape: "html",
  }).replace(/\r?\n/g, "<br>");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px;">${htmlInner}</body></html>`;
  try {
    await sendEmail({
      archive: false,
      to,
      subject: subject || "Workflow notification",
      text,
      html,
      from: tenantFrom(ctx.subAccount),
      subAccount: ctx.subAccount,
      meter: { subAccountId: ctx.subAccountId },
    });
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "send_failed"}`,
    };
  }
};

const execWebhook: NodeExecutor = async (ctx) => {
  const url = ((ctx.node.config as unknown as WebhookConfig).url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return { result: { kind: "next" }, log: "skipped:bad_url" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  // The submitted form's answers (label → value), captured at enrollment.
  // Empty {} for triggers that don't carry a form (e.g. pipeline change, test).
  const tc = ctx.triggerContext ?? {};
  const formData =
    tc.formData && typeof tc.formData === "object"
      ? (tc.formData as Record<string, unknown>)
      : {};
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "workflow.webhook",
        contact: {
          id: ctx.contact.id,
          name: ctx.contact.name,
          email: ctx.contact.email,
          phone: ctx.contact.phone,
        },
        form: {
          id: typeof tc.formId === "string" ? tc.formId : null,
          name: typeof tc.formName === "string" ? tc.formName : null,
          fields: formData,
        },
      }),
      signal: controller.signal,
    });
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "webhook_failed"}`,
    };
  } finally {
    clearTimeout(timer);
  }
};

/** Unimplemented node types pass through (no stall) until their slice lands. */
const execPassThrough: NodeExecutor = async () => ({
  result: { kind: "next" },
  log: "unsupported_passthrough",
});

const REGISTRY: Partial<Record<WorkflowNodeType, NodeExecutor>> = {
  send_email: execSendEmail,
  send_sms: execSendSms,
  whatsapp_template: execWhatsappTemplate,
  send_whatsapp: execSendWhatsapp,
  wait: execWait,
  if_else: execIfElse,
  goal: execGoal,
  add_tag: execAddTag,
  remove_tag: execRemoveTag,
  move_stage: execMoveStage,
  update_field: execUpdateField,
  create_task: execCreateTask,
  notify: execNotify,
  webhook: execWebhook,
};

/* ----------------------------- Dispatch -------------------------------- */

const DEAL_TRIGGERS = new Set<WorkflowTriggerType>([
  "pipeline.stage.changed",
  "deal.created",
  "deal.won",
  "deal.lost",
]);

interface FireInput {
  subAccountId: string;
  agencyId: string;
  type: WorkflowTriggerType;
  contactId: string;
  context?: Record<string, unknown>;
  /**
   * Public-API key that caused this trigger, when the write came in over
   * /api/v1/*. Enrolments are counted against the key's hourly cap (see
   * lib/api/enrolment-cap) so a looping script can't message a whole list.
   */
  apiKeyId?: string;
}

/** Why a matching-type workflow did not take the contact. */
export type EnrolSkipReason =
  | "trigger_mismatch"
  | "filters_not_met"
  | "reentry_blocked"
  | "no_start_node";

/**
 * What one trigger did. Callers that fire and forget ignore it; a caller that
 * owes its client an answer (the v1 contact upsert) awaits it. `reason` is
 * set when nothing was even considered.
 */
export interface TriggerOutcome {
  enrolled: Array<{ workflowId: string; runId: string; status: "running" | "failed" }>;
  skipped: Array<{ workflowId: string; reason: EnrolSkipReason }>;
  reason: "automations_paused" | "no_active_workflow" | "contact_not_found" | "error" | null;
}

/**
 * Find every ACTIVE workflow matching the trigger + filters and enroll the
 * contact. Server-only; never throws — a workflow problem must not break the
 * action that triggered it.
 *
 * When `apiKeyId` is set the caller has already RESERVED one enrolment
 * against that key's hourly cap, so this reconciles the reservation against
 * the number of workflows the contact actually entered. See
 * lib/api/enrolment-cap.
 */
export async function fireWorkflowTrigger(input: FireInput): Promise<TriggerOutcome> {
  const db = getAdminDb();
  const outcome: TriggerOutcome = { enrolled: [], skipped: [], reason: null };
  const settle = (reason: TriggerOutcome["reason"]) => {
    outcome.reason = reason;
    return outcome;
  };
  let enrolled = 0;
  try {
    const subSnap = await db.doc(`subAccounts/${input.subAccountId}`).get();
    if (subSnap.data()?.automationsPaused === true) return settle("automations_paused");

    const matches = await db
      .collection("workflows")
      .where("subAccountId", "==", input.subAccountId)
      .where("status", "==", "active")
      .where("trigger.type", "==", input.type)
      .get();
    if (matches.empty) return settle("no_active_workflow");

    const contactSnap = await db.doc(`contacts/${input.contactId}`).get();
    if (!contactSnap.exists) return settle("contact_not_found");
    const contact = {
      id: contactSnap.id,
      ...(contactSnap.data() as Omit<Contact, "id">),
    };

    for (const doc of matches.docs) {
      const wf = { id: doc.id, ...(doc.data() as Omit<WorkflowDoc, "id">) };
      const skip = (reason: EnrolSkipReason) => {
        outcome.skipped.push({ workflowId: wf.id, reason });
      };
      if (!wf.startNodeId) {
        skip("no_start_node");
        continue;
      }

      // Trigger-specific narrowing.
      if (
        wf.trigger.type === "form.submitted" &&
        wf.trigger.formId &&
        wf.trigger.formId !== input.context?.formId
      ) {
        skip("trigger_mismatch");
        continue;
      }
      if (
        wf.trigger.type === "pipeline.stage.changed" &&
        wf.trigger.toStage &&
        wf.trigger.toStage !== input.context?.toStage
      ) {
        skip("trigger_mismatch");
        continue;
      }
      // Deal triggers may be pinned to one pipeline. Unset = any pipeline,
      // which is what every workflow saved before pipelines existed means.
      if (
        DEAL_TRIGGERS.has(wf.trigger.type) &&
        wf.trigger.pipelineId &&
        wf.trigger.pipelineId !== input.context?.pipelineId
      ) {
        skip("trigger_mismatch");
        continue;
      }
      if (
        wf.trigger.type === "link.clicked" &&
        wf.trigger.linkId &&
        wf.trigger.linkId !== input.context?.linkId
      ) {
        skip("trigger_mismatch");
        continue;
      }
      if (
        wf.trigger.type === "message.received" &&
        wf.trigger.channel &&
        wf.trigger.channel !== input.context?.channel
      ) {
        skip("trigger_mismatch");
        continue;
      }
      // A `contact.tag.added` workflow may name the one tag it starts on.
      // Without it the workflow starts on ANY new tag, and a has_tag filter
      // alone cannot tell "this tag was just added" from "this contact
      // already had it when some other tag arrived".
      if (
        wf.trigger.type === "contact.tag.added" &&
        wf.trigger.tag &&
        !(input.context?.addedTags as string[] | undefined)?.includes(wf.trigger.tag)
      ) {
        skip("trigger_mismatch");
        continue;
      }
      if (!evalConditionGroup(wf.trigger.filters, contact)) {
        skip("filters_not_met");
        continue;
      }
      if (!(await reentryAllows(wf, contact.id))) {
        skip("reentry_blocked");
        continue;
      }

      const run = await enroll(wf, contact.id, input.context ?? {});
      outcome.enrolled.push({ workflowId: wf.id, ...run });
      enrolled += 1;
    }
    return outcome;
  } catch (err) {
    console.error("[workflows] fireWorkflowTrigger failed", err);
    return settle("error");
  } finally {
    // Settle the reservation the route already charged for this request —
    // on EVERY exit path, including the early returns above and a throw
    // part-way through the loop, or a request that enrolled nobody would
    // keep its reservation for the rest of the hour.
    if (input.apiKeyId) {
      await reconcileEnrolments({
        subAccountId: input.subAccountId,
        keyId: input.apiKeyId,
        actual: enrolled,
      });
    }
  }
}

/**
 * Enforce the workflow's re-enrollment policy. "every_time" (default, incl.
 * every pre-v2 doc) never blocks. Equality-only query + in-memory status
 * filter — a contact rarely has more than a handful of runs per workflow.
 * Fails open: an unexpected read error must not silently kill enrollments.
 */
async function reentryAllows(
  wf: WorkflowDoc,
  contactId: string
): Promise<boolean> {
  const policy = wf.reentry ?? "every_time";
  if (policy === "every_time") return true;
  try {
    const snap = await getAdminDb()
      .collection("workflowRuns")
      .where("workflowId", "==", wf.id)
      .where("contactId", "==", contactId)
      .get();
    if (snap.empty) return true;
    if (policy === "once_ever") return false;
    // unless_active — block only while a run is live.
    return !snap.docs.some((d) => {
      const s = (d.data() as WorkflowRunDoc).status;
      return s === "running" || s === "waiting";
    });
  } catch (err) {
    console.warn("[workflows] reentry check failed — allowing", err);
    return true;
  }
}

async function enroll(
  wf: WorkflowDoc,
  contactId: string,
  context: Record<string, unknown>
): Promise<{ runId: string; status: "running" | "failed" }> {
  const db = getAdminDb();
  const runRef = db.collection("workflowRuns").doc();
  await runRef.set({
    id: runRef.id,
    subAccountId: wf.subAccountId,
    agencyId: wf.agencyId,
    workflowId: wf.id,
    contactId,
    status: "running",
    currentNodeId: wf.startNodeId,
    history: [],
    context,
    qstashMessageId: null,
    enrolledAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await db
    .doc(`workflows/${wf.id}`)
    .update({ "stats.enrolled": FieldValue.increment(1) })
    .catch(() => {});
  const run: RunActivityRun = {
    id: runRef.id,
    contactId,
    workflowId: wf.id,
    subAccountId: wf.subAccountId,
    agencyId: wf.agencyId,
  };
  await writeRunActivity(run, wf.name, "automation_started");

  if (!qstashIsConfigured()) {
    await runRef.update({ status: "failed" });
    await writeRunActivity(
      run,
      wf.name,
      "automation_failed",
      "scheduling is not configured"
    );
    return { runId: runRef.id, status: "failed" };
  }
  const scheduled = await scheduleNode(runRef, wf.startNodeId!, 0, run, wf);
  return { runId: runRef.id, status: scheduled ? "running" : "failed" };
}

/* ------------------------------ Run worker ----------------------------- */

/** Returns false when the step could not be published (run marked failed). */
async function scheduleNode(
  runRef: FirebaseFirestore.DocumentReference,
  nodeId: string,
  delaySeconds: number,
  run: RunActivityRun,
  wf: WorkflowDoc | null
): Promise<boolean> {
  const res = await publishCallback({
    pathname: STEP_PATH,
    body: { runId: runRef.id, nodeId },
    delaySeconds,
    deduplicationId: `wf_${runRef.id}_${nodeId}`,
  });
  if (!res) {
    await runRef.update({
      status: "failed",
      updatedAt: FieldValue.serverTimestamp(),
    });
    await writeRunActivity(
      run,
      wf?.name ?? null,
      "automation_failed",
      "the next step could not be scheduled"
    );
    return false;
  }
  await runRef.update({
    currentNodeId: nodeId,
    status: delaySeconds > 0 ? "waiting" : "running",
    qstashMessageId: res.messageId,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return true;
}

/** The run fields a contact-timeline row needs. */
type RunActivityRun = Pick<
  WorkflowRunDoc,
  "id" | "contactId" | "workflowId" | "subAccountId" | "agencyId"
>;

/**
 * `automation_started` / `automation_completed` / `automation_failed` on the
 * contact — the run lifecycle as the operator sees it from the record.
 * Keyed by run + type so a QStash redelivery of the step that flipped the
 * status cannot duplicate the row. Never throws: the run doc is the source
 * of truth and a timeline row must not fail a step.
 */
async function writeRunActivity(
  run: RunActivityRun,
  workflowName: string | null,
  type: "automation_started" | "automation_completed" | "automation_failed",
  detail?: string
): Promise<void> {
  const verb = type.replace("automation_", "");
  const name = workflowName ? `"${workflowName}"` : run.workflowId;
  try {
    await getAdminDb()
      .collection("contacts")
      .doc(run.contactId)
      .collection("activities")
      .doc(`run_${run.id}_${type}`)
      .set(
        {
          type,
          content: `Workflow ${name} ${verb}${detail ? ` — ${detail}` : ""}`,
          createdBy: "workflow",
          agencyId: run.agencyId,
          subAccountId: run.subAccountId,
          meta: { workflowId: run.workflowId, runId: run.id },
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  } catch (err) {
    console.warn(`[workflows] ${type} activity write failed`, err);
  }
}

async function completeRun(
  runRef: FirebaseFirestore.DocumentReference,
  run: RunActivityRun,
  wf: WorkflowDoc | null
): Promise<void> {
  await runRef.update({
    status: "completed",
    currentNodeId: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await getAdminDb()
    .doc(`workflows/${run.workflowId}`)
    .update({ "stats.completed": FieldValue.increment(1) })
    .catch(() => {});
  await writeRunActivity(run, wf?.name ?? null, "automation_completed");
}

/** Advance one node of a run. Idempotent on the run's history. */
export async function runStep(
  runId: string,
  nodeId: string,
  phase?: "timeout"
): Promise<void> {
  const db = getAdminDb();
  const runRef = db.collection("workflowRuns").doc(runId);
  const runSnap = await runRef.get();
  if (!runSnap.exists) return;
  const run = runSnap.data() as WorkflowRunDoc;

  if (run.status !== "running" && run.status !== "waiting") return;
  if (run.history.some((h) => h.nodeId === nodeId)) return; // QStash retry

  const wfSnap = await db.doc(`workflows/${run.workflowId}`).get();
  if (!wfSnap.exists) {
    await runRef.update({
      status: "failed",
      updatedAt: FieldValue.serverTimestamp(),
    });
    await writeRunActivity(
      run,
      null,
      "automation_failed",
      "the workflow no longer exists"
    );
    return;
  }
  const wf = wfSnap.data() as WorkflowDoc;
  // Test runs execute regardless of status so a draft can be dry-run; real
  // enrollments require the workflow to still be active.
  if (wf.status !== "active" && run.context?.test !== true) {
    await runRef.update({
      status: "exited",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  const node = wf.nodes[nodeId];
  if (!node) {
    await completeRun(runRef, run, wf);
    return;
  }

  // wait_for_reply is a two-phase node handled outside the registry: it arms
  // (parks the run + schedules a timeout), then is resolved EITHER by the
  // inbound-message hook (Replied) or the timeout callback (No reply).
  if (node.type === "wait_for_reply") {
    await stepWaitForReply(runRef, run, wf, node, phase);
    return;
  }

  const contactSnap = await db.doc(`contacts/${run.contactId}`).get();
  if (!contactSnap.exists) {
    await runRef.update({
      status: "failed",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }
  const contact = {
    id: contactSnap.id,
    ...(contactSnap.data() as Omit<Contact, "id">),
  };

  const [subSnap, agencySnap] = await Promise.all([
    db.doc(`subAccounts/${run.subAccountId}`).get(),
    db.doc(`agencies/${run.agencyId}`).get(),
  ]);
  const subAccount = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;
  const agency = agencySnap.exists ? (agencySnap.data() as AgencyDoc) : null;

  if (subAccount?.automationsPaused === true) {
    await runRef.update({
      status: "exited",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  const owner = await loadOwner(agency);
  const exec = REGISTRY[node.type] ?? execPassThrough;
  const { result, log } = await exec({
    node,
    contact,
    subAccount,
    owner,
    subAccountId: run.subAccountId,
    agencyId: run.agencyId,
    createdByUid: wf.createdByUid,
    workflowId: run.workflowId,
    runId,
    triggerContext: run.context ?? {},
  });

  const entry: WorkflowRunHistoryEntry = {
    nodeId,
    type: node.type,
    at: Timestamp.now(),
    result: log,
  };
  await runRef.update({
    history: FieldValue.arrayUnion(entry),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Advance control flow.
  let target: string | null = null;
  let delay = 0;
  if (result.kind === "end") {
    await completeRun(runRef, run, wf);
    return;
  } else if (result.kind === "branch") {
    const b = node.branches;
    target = (result.value ? b?.whenTrue : b?.whenFalse) ?? null;
  } else if (result.kind === "wait") {
    target = node.next ?? null;
    delay = result.seconds;
  } else {
    target = node.next ?? null;
  }

  if (!target) {
    await completeRun(runRef, run, wf);
    return;
  }
  await scheduleNode(runRef, target, delay, run, wf);
}

/* --------------------------- wait_for_reply ---------------------------- */

/**
 * Two-phase wait_for_reply.
 *
 * Arm (first entry, `phase` absent): stamp `run.waiting`, park the run as
 * "waiting", and schedule a timeout callback that re-enters this SAME node
 * with `phase: "timeout"`. No history entry is appended — the history entry
 * IS the resolution marker, and appending it here would make the step
 * worker's idempotency guard treat the node as already resolved.
 *
 * Timeout (`phase === "timeout"`): claim the node in a transaction — a reply
 * may have resolved it first (the claim re-checks `waiting` + history inside
 * the transaction, so exactly one path wins). On claim, advance to the
 * No-reply branch.
 *
 * A QStash retry of the ARM message re-runs the arm path: the timeout
 * publish is deduplicated by id and the `waiting` re-stamp is idempotent.
 */
async function stepWaitForReply(
  runRef: FirebaseFirestore.DocumentReference,
  run: WorkflowRunDoc,
  wf: WorkflowDoc,
  node: WorkflowNode,
  phase: "timeout" | undefined
): Promise<void> {
  const db = getAdminDb();

  if (phase !== "timeout") {
    // Phase 1 — arm. Stamp `waiting` BEFORE publishing the timeout so the
    // callback can never race an unstamped run; if we die between the two
    // writes, QStash's retry of the arm message re-runs this idempotently.
    const cfg = node.config as unknown as WaitForReplyConfig;
    const seconds = Math.max(60, Math.floor(cfg.seconds ?? 0));
    await runRef.update({
      waiting: {
        nodeId: node.id,
        kind: "reply",
        since: Timestamp.now(),
        until: Timestamp.fromMillis(Date.now() + seconds * 1000),
      },
      status: "waiting",
      currentNodeId: node.id,
      updatedAt: FieldValue.serverTimestamp(),
    });
    const res = await publishCallback({
      pathname: STEP_PATH,
      body: { runId: run.id, nodeId: node.id, phase: "timeout" },
      delaySeconds: seconds,
      deduplicationId: `wf_${run.id}_${node.id}_timeout`,
    });
    if (!res) {
      await runRef.update({
        waiting: null,
        status: "failed",
        updatedAt: FieldValue.serverTimestamp(),
      });
      await writeRunActivity(
        run,
        wf.name,
        "automation_failed",
        "the reply timeout could not be scheduled"
      );
      return;
    }
    await runRef.update({ qstashMessageId: res.messageId });
    return;
  }

  // Phase 2 — timeout. Claim, then take the No-reply branch.
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(runRef);
    if (!snap.exists) return false;
    const r = snap.data() as WorkflowRunDoc;
    if (r.waiting?.nodeId !== node.id) return false; // a reply won the race
    if (r.history.some((h) => h.nodeId === node.id)) return false;
    const entry: WorkflowRunHistoryEntry = {
      nodeId: node.id,
      type: node.type,
      at: Timestamp.now(),
      result: "timeout",
    };
    tx.update(runRef, {
      waiting: null,
      status: "running",
      history: FieldValue.arrayUnion(entry),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
  if (!claimed) return;

  const target = node.branches?.whenFalse ?? null;
  if (!target) {
    await completeRun(runRef, run, wf);
    return;
  }
  await scheduleNode(runRef, target, 0, run, wf);
}

/**
 * Resolve every run of this contact parked on a `wait_for_reply` node — the
 * contact replied. Called (fire-and-forget) from the unified-inbox upsert for
 * every inbound SMS/WhatsApp/Messenger/Instagram message. Web chat and email
 * deliberately don't count: web chat sessions live outside the inbox, and
 * email replies route to the operator's own inbox and never touch the app.
 *
 * Equality-only query (contactId + status) — no composite index needed.
 * Never throws: a workflow problem must not break the inbound webhook.
 * Returns how many runs this reply resumed — 0 tells the caller nothing was
 * waiting (a late button tap is flagged for a human on that basis).
 */
export async function resumeWaitingRunsOnReply(input: {
  subAccountId: string;
  contactId: string;
  channel: string;
  /** The inbound message body, so a downstream if_else can branch on WHAT the
   *  contact said and not merely that they said something. Optional: callers
   *  that predate this still resume the run, they just cannot branch on it. */
  text?: string | null;
}): Promise<number> {
  let resumed = 0;
  try {
    const db = getAdminDb();
    const snap = await db
      .collection("workflowRuns")
      .where("contactId", "==", input.contactId)
      .where("status", "==", "waiting")
      .get();
    if (snap.empty) return 0;

    for (const doc of snap.docs) {
      const run = doc.data() as WorkflowRunDoc;
      if (run.subAccountId !== input.subAccountId) continue;
      const waiting = run.waiting;
      if (!waiting || waiting.kind !== "reply") continue; // plain timer wait
      const nodeId = waiting.nodeId;

      const claimed = await db.runTransaction(async (tx) => {
        const s = await tx.get(doc.ref);
        if (!s.exists) return false;
        const r = s.data() as WorkflowRunDoc;
        if (r.waiting?.nodeId !== nodeId) return false; // timeout won the race
        if (r.history.some((h) => h.nodeId === nodeId)) return false;
        const entry: WorkflowRunHistoryEntry = {
          nodeId,
          type: "wait_for_reply",
          at: Timestamp.now(),
          result: `replied:${input.channel}`,
        };
        // Capped: a run doc is read on every step, and an unbounded inbound
        // body would be carried for the life of the run.
        const replyText = (input.text ?? "").slice(0, REPLY_TEXT_MAX);
        tx.update(doc.ref, {
          waiting: null,
          status: "running",
          history: FieldValue.arrayUnion(entry),
          "context.lastReply": {
            text: replyText,
            channel: input.channel,
            at: Timestamp.now(),
          },
          updatedAt: FieldValue.serverTimestamp(),
        });
        return true;
      });
      if (!claimed) continue;
      resumed += 1;

      const wfSnap = await db.doc(`workflows/${run.workflowId}`).get();
      const wf = wfSnap.exists ? (wfSnap.data() as WorkflowDoc) : null;
      const target = wf?.nodes?.[nodeId]?.branches?.whenTrue ?? null;
      if (!target) {
        await completeRun(doc.ref, run, wf);
        continue;
      }
      await scheduleNode(doc.ref, target, 0, run, wf);
    }
  } catch (err) {
    console.warn("[workflows] resumeWaitingRunsOnReply failed", err);
  }
  return resumed;
}

/** Manually enroll one contact to dry-run a workflow (ignores trigger/filters;
 *  runs even on a draft via the `test` context flag). */
export async function enrollForTest(opts: {
  subAccountId: string;
  workflowId: string;
  contactId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const db = getAdminDb();
  const wfSnap = await db.doc(`workflows/${opts.workflowId}`).get();
  if (!wfSnap.exists) return { ok: false, error: "Workflow not found" };
  const wf = { id: wfSnap.id, ...(wfSnap.data() as Omit<WorkflowDoc, "id">) };
  if (wf.subAccountId !== opts.subAccountId) {
    return { ok: false, error: "Workflow not found" };
  }
  if (!wf.startNodeId)
    return { ok: false, error: "Add at least one step first" };
  const cSnap = await db.doc(`contacts/${opts.contactId}`).get();
  if (!cSnap.exists || cSnap.data()!.subAccountId !== opts.subAccountId) {
    return { ok: false, error: "Contact not found" };
  }
  await enroll(wf, opts.contactId, { test: true });
  return { ok: true };
}

async function loadOwner(
  agency: AgencyDoc | null
): Promise<{ displayName: string; email: string }> {
  if (!agency?.ownerUid) return { displayName: "", email: "" };
  try {
    const snap = await getAdminDb().doc(`users/${agency.ownerUid}`).get();
    const d = snap.data();
    return {
      displayName: (d?.displayName as string) ?? "",
      email: (d?.email as string) ?? "",
    };
  } catch {
    return { displayName: "", email: "" };
  }
}
