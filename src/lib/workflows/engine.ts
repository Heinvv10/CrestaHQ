import "server-only";

import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendEmail, emailIsConfigured, tenantFrom } from "@/lib/comms/resend";
import { isEmailSuppressedError } from "@/lib/comms/email-suppression";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import { dispatchWhatsappTemplateSend } from "@/lib/comms/whatsapp/template-dispatch";
import { dispatchWhatsappSend } from "@/lib/comms/whatsapp/send-dispatch";
import { checkWhatsappReadiness } from "@/lib/comms/whatsapp/readiness";
import { isTemplateApprovedFor, templateRegistration } from "@/lib/comms/whatsapp/template-registrations";
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
import { isAssignableMember } from "@/lib/server/assignee";
import { updateDealServerSide } from "@/lib/server/deals-service";
import { loadPipeline } from "@/lib/pipelines/server";
import { dealPipelineId, findStage } from "@/lib/pipelines/stages";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { checkQuota, UsageQuotaExceededError } from "@/lib/server/usage-meter";
import { reconcileEnrolments } from "@/lib/api/enrolment-cap";
import {
  resolveMergeTags,
  type MergeTagSubject,
} from "@/lib/automations/merge-tags";
import { buildUnsubscribeUrl } from "@/lib/automations/unsubscribe-token";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import { logIfReviewAsk, type TemplateIdentity } from "@/lib/reviews/review-ask";
import { providerAttempted } from "@/lib/comms/provider-attempt";
import { formatHoldUntil, isQuietHoursDeferred, type QuietHoursHold } from "@/lib/comms/quiet-hours";
import { writeHoldActivity } from "@/lib/comms/quiet-hours-hold";
import { APPROACH_CAP_LOG, guardProspectSend } from "@/lib/prospecting/approach-guard";
import type { ReviewRequestChannel } from "@/lib/reviews/request-log";
import { evalConditionGroup } from "./conditions";
import {
  agentHold,
  type AgentActor,
  type HeldEnrolment,
  type HoldFailure,
} from "./agent-hold";
import { writeHeldEnrolment } from "@/lib/server/agent-held-enrolment";
import { workflowStepsFingerprint } from "@/lib/workflows/steps-fingerprint";
import { publicFetch } from "@/lib/webhooks/public-fetch";
import type { Contact } from "@/types/contacts";
import type { AgencyDoc, SubAccountDoc } from "@/types";
import type { WhatsappTemplateDoc, WhatsappTemplateButton } from "@/types/whatsapp-templates";
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
import { readSubAccountSecret } from "@/lib/server/sub-account-secrets";

const STEP_PATH = "/api/workflows/step";
/**
 * QStash retries per step delivery — set explicitly (it is also QStash's
 * default) so the step route can tell the LAST delivery from its
 * `Upstash-Retried` header and fail the run instead of letting it hang.
 */
export const WORKFLOW_STEP_RETRIES = 3;

/* --------------------------- Node executors ---------------------------- */

export type StepResult =
  | { kind: "next" }
  | { kind: "wait"; seconds: number }
  | { kind: "branch"; value: boolean }
  | { kind: "end" }
  /** The step definitely did not do its job; the run stops as `failed`. */
  | { kind: "fail" }
  /** Nothing was sent — quiet hours. Run THIS step again when they end. */
  | { kind: "defer"; hold: QuietHoursHold };

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
  /** When the customer made the booking this run confirms — set only for a
   *  booking-confirmation run of a customer's own booking-page booking (the
   *  quiet-hours exemption, lib/comms/quiet-hours.ts). */
  selfTriggeredBookingAt?: Date | null;
  /**
   * Set by a send executor once its outbound content is rendered, and its
   * provider id once sent (SP5 d1). runStep logs the step as a review ask
   * when that content carries the sub-account's review link — a failed one
   * only when `attempted` says a provider was actually called.
   */
  sent?: {
    channel: ReviewRequestChannel;
    parts: string[];
    template?: TemplateIdentity | null;
    templateValues?: string[];
    messageSid?: string | null;
    attempted?: boolean;
  };
}

/** An executor returns the control-flow result + a short audit log string. */
type NodeExecutor = (
  ctx: NodeContext
) => Promise<{ result: StepResult; log: string }>;

/**
 * A failed template send stops the run only when the message definitely did
 * not go out. Continuing past a send that never happened parks the run on a
 * wait_for_reply for a message the customer never got, and its "no reply"
 * branch then files a misleading follow-up. An AMBIGUOUS failure (a timeout
 * after the request left, a provider 5xx) continues: the customer may well
 * have the message, and acting as if they don't is the worse mistake.
 *
 * Template node only. `send_whatsapp` continues on every failure: its next
 * steps (a follow-up task, a tag) are work that must still happen for the
 * customer whether or not the message went out.
 */
function whatsappSendFailed(
  log: string,
  definitelyNotSent: boolean
): { result: StepResult; log: string } {
  return { result: definitelyNotSent ? { kind: "fail" } : { kind: "next" }, log };
}

/** No provider call, a rail refusal, or a provider's definite rejection. An
 *  AMBIGUOUS outcome wins over all three — the bridge names a refusal such as
 *  `in_flight` for a send that may still go out.
 *  Exported for tests only: no template rail returns `refusedBy` today. */
export function definitelyNotSent(res: {
  attempted?: boolean;
  refusedBy?: string;
  providerOutcome?: "DEFINITELY_REJECTED" | "AMBIGUOUS";
}): boolean {
  if (res.providerOutcome === "AMBIGUOUS") return false;
  return (
    res.attempted !== true ||
    Boolean(res.refusedBy) ||
    res.providerOutcome === "DEFINITELY_REJECTED"
  );
}

/** An SMS/WhatsApp step held by quiet hours: the step runs again when they
 *  end, re-reading the contact (opt-out) like any step. */
function deferForQuietHours(hold: QuietHoursHold): { result: StepResult; log: string } {
  return {
    result: { kind: "defer", hold },
    log: `deferred:quiet_hours_until_${hold.until.toISOString()}`,
  };
}

/**
 * The channel opt-out each send executor refuses on first. Shared with the
 * approach guard in runStep, which runs only past it (and past a missing
 * address), so an opted-out prospect is never stamped or counted.
 */
function channelOptedOut(type: WorkflowNodeType, contact: Contact): boolean {
  if (type === "send_email") return Boolean(contact.emailOptedOut);
  if (type === "send_sms") return Boolean(smsSendBlock(contact));
  return Boolean(contact.whatsappOptedOut);
}

/** The send executor will skip without sending: opted out, or no address. */
function sendSkips(type: WorkflowNodeType, contact: Contact): boolean {
  const address = type === "send_email" ? contact.email : contact.phone;
  return channelOptedOut(type, contact) || !address;
}

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
    prospecting: {
      headline: ctx.contact.prospecting?.lastReportHeadline ?? "",
      reportUrl: ctx.contact.prospecting?.lastReportUrl ?? "",
    },
  };
}

const execSendEmail: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as SendEmailConfig;
  const contact = ctx.contact;
  if (channelOptedOut(ctx.node.type, contact))
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
  // A workflow email is marketing as often as not (steps carry no
  // transactional flag), so like a broadcast it must carry an unsubscribe
  // link. Broadcasts refuse a template without one up front; a step in a live
  // automation appends it instead of failing a customer's sequence mid-run.
  const rawBody = cfg.body ?? "";
  const body = /\{\{\s*unsubscribeLink\s*\}\}/.test(rawBody)
    ? rawBody
    : `${rawBody}\n\n{{unsubscribeLink}}`;
  const subject = resolveMergeTags(
    cfg.subject ?? "",
    mergeSubject(ctx, unsubscribeLink)
  );
  const text = resolveMergeTags(body, mergeSubject(ctx, unsubscribeLink));
  // HTML render: substituted values are escaped (a contact's name or a
  // custom field set over the public API is untrusted free text), but the
  // unsubscribe anchor we supply ourselves must stay real markup.
  const htmlInner = resolveMergeTags(
    body,
    // No app URL configured → no link: omit the anchor rather than ship an
    // empty href (same as the broadcast step).
    mergeSubject(
      ctx,
      unsubscribeLink ? `<a href="${unsubscribeLink}">Unsubscribe</a>` : ""
    ),
    { escape: "html", safeTags: ["unsubscribeLink"] }
  ).replace(/\r?\n/g, "<br>");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px;">${htmlInner}</body></html>`;
  ctx.sent = { channel: "email", parts: [subject, text] };

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
    ctx.sent.messageSid = messageId;
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
    if (isEmailSuppressedError(err)) {
      return { result: { kind: "next" }, log: "skipped:suppressed" };
    }
    ctx.sent.attempted = providerAttempted(err);
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "send_failed"}`,
    };
  }
};

const execSendSms: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as SendSmsConfig;
  const contact = ctx.contact;
  if (channelOptedOut(ctx.node.type, contact))
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
  ctx.sent = { channel: "sms", parts: [body] };
  try {
    const sent = await sendSmsForSubAccount({
      subAccountId: ctx.subAccountId,
      subAccount: ctx.subAccount,
      to,
      body,
      selfTriggeredBookingAt: ctx.selfTriggeredBookingAt,
    });
    ctx.sent.messageSid = sent.sid;
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
    if (isQuietHoursDeferred(err)) return deferForQuietHours(err.hold);
    if (err instanceof UsageQuotaExceededError) {
      return { result: { kind: "next" }, log: "skipped:quota" };
    }
    ctx.sent.attempted = providerAttempted(err);
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
  if (channelOptedOut(ctx.node.type, contact))
    return { result: { kind: "next" }, log: "skipped:opt_out" };
  const to = contact.phone;
  if (!to) return { result: { kind: "next" }, log: "skipped:no_phone" };
  // Requires the agency WhatsApp gate AND a configured WhatsApp sender. The
  // builder surfaces this as a red node, but re-check here in case the gate
  // flipped off after the workflow was built.
  if (ctx.subAccount?.whatsappEnabledByAgency !== true) {
    return whatsappSendFailed("error:whatsapp_not_configured", true);
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
    return whatsappSendFailed("error:whatsapp_not_configured", true);
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
    return whatsappSendFailed("error:template_not_approved", true);
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
  ctx.sent = { channel: "whatsapp", parts: [], template: tpl, templateValues: contentVariables };
  // A blank variable is refused before any rail sees it: Twilio may send the
  // template's SAMPLE value in its place (a stranger's name to a real
  // customer), and Cloud would send the gap.
  if (contentVariables.some((v) => !v.trim())) {
    return whatsappSendFailed("error:WA_TEMPLATE_VARIABLE_EMPTY", true);
  }

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
      selfTriggeredBookingAt: ctx.selfTriggeredBookingAt,
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
    if (res.quietHours) return deferForQuietHours(res.quietHours);
    if (!res.ok) {
      ctx.sent.attempted = res.attempted === true && !res.refusedBy;
      return whatsappSendFailed(`error:${res.error ?? "send_failed"}`, definitelyNotSent(res));
    }
    ctx.sent.messageSid = res.messageId ?? null;
    // Recorded exactly as send_whatsapp and the manual template route record
    // it, so an operator reads the rendered template in the thread. A record
    // failure after a real send does not fail the run: the message went out.
    const rendered = (tpl.body ?? "").replace(
      /\{\{\s*(\d+)\s*\}\}/g,
      (_match, position: string) => contentVariables[Number(position) - 1] ?? "",
    );
    try {
      const messages = getAdminDb().collection(`contacts/${contact.id}/whatsappMessages`);
      const messageRef = res.messageId ? messages.doc(res.messageId) : messages.doc();
      await messageRef.set({
        agencyId: ctx.agencyId,
        subAccountId: ctx.subAccountId,
        contactId: contact.id,
        direction: "outbound",
        status: "sent",
        body: rendered,
        buttons: null,
        from: tplReadiness.sender.phoneNumber,
        to,
        twilioMessageSid: res.messageId ?? null,
        sentByUid: null,
        error: null,
        readAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.warn("[workflows] WhatsApp template message-row write failed", err);
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
      body: rendered || `[Template: ${tpl.displayName}]`,
    });
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    if (err instanceof UsageQuotaExceededError) {
      // Stops the run. The quota is checked before the provider is called, so
      // nothing went out — waiting on a reply to it would only manufacture a
      // "no reply" follow-up. The log stays `skipped:` so it is not counted as
      // a failed review ask.
      return whatsappSendFailed("skipped:quota", true);
    }
    ctx.sent.attempted = providerAttempted(err);
    return whatsappSendFailed(
      `error:${err instanceof Error ? err.message : "send_failed"}`,
      !ctx.sent.attempted,
    );
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
  if (channelOptedOut(ctx.node.type, contact))
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
  // What goes out depends on the window, decided by the dispatcher; until it
  // answers, either could.
  ctx.sent = { channel: "whatsapp", parts: [body], template: tplDoc, templateValues };
  const twilioContentSid = isTemplateApprovedFor(tplDoc, "twilio")
    ? templateRegistration(tplDoc, "twilio")?.externalId ?? null
    : null;

  try {
    const res = await dispatchWhatsappSend({
      subAccountId: ctx.subAccountId,
      subAccount: ctx.subAccount,
      contactId: contact.id,
      to,
      body,
      template,
      inWindowButtons,
      // Bridge rail: a redelivery converges on this send instead of repeating it.
      idempotencyKey: `wf_${ctx.runId}_${ctx.node.id}`,
      selfTriggeredBookingAt: ctx.selfTriggeredBookingAt,
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
                authToken: await readSubAccountSecret(
                  ctx.subAccountId,
                  "twilio",
                  ctx.subAccount!.twilioConfig,
                ),
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
      // Out of window on Twilio the approved template goes by Content SID.
      sendTemplateViaTwilio: twilioContentSid
        ? async () => {
            // Twilio may fill a blank variable with the template's SAMPLE
            // value — a stranger's name to a real customer. Refused unsent.
            if (templateValues.some((v) => !v.trim())) {
              return {
                ok: false,
                error: "WA_TEMPLATE_VARIABLE_EMPTY",
                providerOutcome: "DEFINITELY_REJECTED",
                attempted: false,
              };
            }
            const r = await sendWhatsappTemplateForSubAccount({
              subAccountId: ctx.subAccountId,
              subAccount: ctx.subAccount,
              to,
              contentSid: twilioContentSid,
              contentVariables: templateValues,
            });
            return { ok: true, messageId: r.sid };
          }
        : undefined,
    });
    if (res.quietHours) return deferForQuietHours(res.quietHours);
    if (!res.ok) {
      ctx.sent.attempted = res.attempted === true && !res.refusedBy;
      return {
        result: { kind: "next" },
        log: `error:${res.error ?? "send_failed"}`,
      };
    }
    // A successful provider call does not write the CRM thread. Use the same
    // provider message id as the manual composer so the row is addressable.
    // Keep recording failures distinct: the message has already been sent.
    const sentTemplate = res.sentAs === "template" || res.sentAs === "interactive";
    const recordedBody = sentTemplate ? templateBody : body;
    // Only an actual interactive-button send records buttons — a template
    // send that fell back to plain text (outside the window) shows no
    // buttons the customer never received.
    const recordedButtons: WhatsappTemplateButton[] | null =
      res.sentAs === "interactive" && tplDoc?.buttons?.length ? tplDoc.buttons : null;
    ctx.sent = sentTemplate
      ? { channel: "whatsapp", parts: [], template: tplDoc, templateValues, messageSid: res.messageId ?? null }
      : { channel: "whatsapp", parts: [body], messageSid: res.messageId ?? null };
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
          buttons: recordedButtons,
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
    ctx.sent.attempted = providerAttempted(err);
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

/**
 * A deal move fires `pipeline.stage.changed`, which can enrol the contact in
 * another run whose move_stage moves the deal again. A run never re-enters
 * itself (each trigger enrols a NEW run), and a move to the stage the deal is
 * already in fires nothing, so a workflow cannot loop on its own — but two
 * workflows moving the deal back and forth would, forever. Each workflow-made
 * move therefore carries its depth on the trigger context; past this many
 * hops the step leaves the deal alone.
 */
const MAX_WORKFLOW_DEAL_MOVES = 5;

const execMoveStage: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as MoveStageConfig;
  const stage = (cfg.stage ?? "").trim();
  if (!stage) return { result: { kind: "next" }, log: "skipped:no_stage" };
  await getAdminDb()
    .doc(`contacts/${ctx.contact.id}`)
    .update({ pipelineStage: stage, updatedAt: FieldValue.serverTimestamp() });
  const pipelineId = (cfg.pipelineId ?? "").trim();
  if (!pipelineId) return { result: { kind: "next" }, log: `stage:${stage}` };
  const deal = await moveContactDeal(ctx, pipelineId, stage);
  return { result: { kind: "next" }, log: `stage:${stage};deal:${deal}` };
};

const toMillis = (v: unknown): number =>
  v instanceof Date
    ? v.getTime()
    : typeof (v as Timestamp | undefined)?.toMillis === "function"
      ? (v as Timestamp).toMillis()
      : 0;

/** Move the contact's most recently updated open deal in `pipelineId` to
 *  `stage` through the deals service. Returns the step-log suffix. */
async function moveContactDeal(
  ctx: NodeContext,
  pipelineId: string,
  stage: string
): Promise<string> {
  const depth = Number(ctx.triggerContext.workflowDepth) || 0;
  if (depth >= MAX_WORKFLOW_DEAL_MOVES) return "skipped:loop_guard";
  const pipeline = await loadPipeline(ctx.subAccountId, pipelineId);
  if (!pipeline) return "skipped:pipeline_not_found";
  if (!findStage(pipeline, stage)) return "skipped:stage_not_in_pipeline";

  // Equality-only query; pipeline + open filtering in memory, because a deal
  // with no pipelineId belongs to the default pipeline and a query can't
  // match a missing field.
  const snap = await getAdminDb()
    .collection("deals")
    .where("subAccountId", "==", ctx.subAccountId)
    .where("contactId", "==", ctx.contact.id)
    .get();
  const open = snap.docs
    .map((d) => ({ id: d.id, data: d.data() }))
    .filter(
      ({ data }) =>
        dealPipelineId(data) === pipeline.id &&
        !findStage(pipeline, data.stageId as string)?.terminal
    )
    .sort((a, b) => toMillis(b.data.updatedAt) - toMillis(a.data.updatedAt));
  const target = open[0];
  if (!target) return "skipped:no_open_deal";
  if (target.data.stageId === stage) return `unchanged:${target.id}`;

  await updateDealServerSide({
    dealId: target.id,
    patch: { stageId: stage },
    userId: ctx.createdByUid,
    expectedSubAccountId: ctx.subAccountId,
    workflowDepth: depth + 1,
    source: "workflow",
  });
  return `moved:${target.id}`;
}

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
  // A custom field is exactly one path segment under customFields: an empty
  // key ("customFields.") or one carrying `.`, `~`, `*`, `/`, `[`, `]` is not
  // a valid Firestore field path — the update throws on every retry.
  const customKey = field.startsWith("customFields.")
    ? field.slice("customFields.".length)
    : null;
  const writable =
    customKey === null
      ? WRITABLE_FIELDS.has(field)
      : /^[^.~*/[\]]+$/.test(customKey);
  if (!writable) {
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
  // Checked at run time, not save time: a member removed after the workflow
  // was saved must not keep receiving tasks.
  const wanted =
    typeof cfg.assignedToUid === "string" ? cfg.assignedToUid.trim() : "";
  const assignedToUid =
    wanted && (await isAssignableMember(ctx.subAccountId, wanted))
      ? wanted
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
    assignedToUid,
    workflow: { workflowId: ctx.workflowId, runId: ctx.runId },
  });
  return {
    result: { kind: "next" },
    log:
      wanted && !assignedToUid ? "task_created:unassigned_not_member" : "task_created",
  };
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
    if (isEmailSuppressedError(err)) {
      return { result: { kind: "next" }, log: "skipped:suppressed" };
    }
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "send_failed"}`,
    };
  }
};

export const execWebhook: NodeExecutor = async (ctx) => {
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
    // publicFetch: the URL is tenant-authored, so no internal addresses and
    // no redirects.
    await publicFetch(url, {
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

const BOOKING_TRIGGERS = new Set<WorkflowTriggerType>([
  "booking.created",
  "booking.cancelled",
  "booking.rescheduled",
  "booking.confirmed",
  "booking.showed",
  "booking.no_show",
]);

/** The booking triggers a customer's own booking-page booking produces. */
const SELF_BOOKING_CONFIRMATION_TRIGGERS = new Set<WorkflowTriggerType>([
  "booking.created",
  "booking.confirmed",
  "booking.rescheduled",
]);

/**
 * The quiet-hours exemption's first condition, mirroring the bridge's "human
 * reply": this run confirms a booking the customer made themselves on a
 * public booking page (only those carry a `bookingPageSlug`; an operator's
 * calendar entry does not). The second — that it happened minutes ago — is
 * `quietHoursHold`'s: enrolment time stands in for the booking, so a step
 * behind a wait is long past it.
 */
function selfTriggeredBookingAt(wf: WorkflowDoc, run: WorkflowRunDoc): Date | null {
  const type = wf.trigger?.type;
  if (!type || !SELF_BOOKING_CONFIRMATION_TRIGGERS.has(type)) return null;
  const slug = run.context?.bookingPageSlug;
  if (typeof slug !== "string" || !slug) return null;
  const at = run.enrolledAt as { toDate?: () => Date } | null;
  return typeof at?.toDate === "function" ? at.toDate() : null;
}

export interface FireInput {
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
  /**
   * Set when an API agent's write fired this trigger: every workflow the
   * contact would enter becomes a `workflow_enrolment` proposal instead of a
   * run (ruling Q). No enrolment is reserved then — approve reserves it.
   */
  hold?: AgentActor;
  /** Approve-time replay of a held enrolment: match this workflow only. */
  onlyWorkflowId?: string;
  /**
   * An approved action's reviewed workflows: id -> steps fingerprint
   * (workflowStepsFingerprint). Only a workflow listed here whose live steps
   * still match enrols; any other is skipped `steps_changed`.
   */
  expectedStepsFingerprints?: Record<string, string>;
}

/** Why a matching-type workflow did not take the contact. */
export type EnrolSkipReason =
  | "trigger_mismatch"
  | "filters_not_met"
  | "reentry_blocked"
  /** The re-entry transaction errored; not enrolled (fails closed). */
  | "reentry_check_failed"
  | "no_start_node"
  /** Not a workflow the approver reviewed, or its steps changed since. */
  | "steps_changed"
  /** An agent's hold could not be written (e.g. an unsettled earlier
   *  approval of it); nothing was enrolled. */
  | "hold_refused";

/**
 * What one trigger did. Callers that fire and forget ignore it; a caller that
 * owes its client an answer (the v1 contact upsert) awaits it. `reason` is
 * set when nothing was even considered.
 */
export interface TriggerOutcome {
  enrolled: Array<{ workflowId: string; runId: string; status: "running" | "failed" }>;
  skipped: Array<{ workflowId: string; reason: EnrolSkipReason }>;
  /** Agent surface only: enrolments written as proposals instead of runs. */
  held?: HeldEnrolment[];
  /** Agent surface only: matched workflows whose hold could not be written. */
  holdFailures?: HoldFailure[];
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

    let query = db
      .collection("workflows")
      .where("subAccountId", "==", input.subAccountId)
      .where("status", "==", "active")
      .where("trigger.type", "==", input.type);
    if (input.onlyWorkflowId) {
      query = query.where(FieldPath.documentId(), "==", input.onlyWorkflowId);
    }
    const matches = await query.get();
    if (matches.empty) return settle("no_active_workflow");

    const contactSnap = await db.doc(`contacts/${input.contactId}`).get();
    if (!contactSnap.exists) return settle("contact_not_found");
    if (contactSnap.data()?.subAccountId !== input.subAccountId) {
      console.warn(
        `[workflows] trigger ${input.type} refused: contact ${input.contactId} is not in sub-account ${input.subAccountId}`,
      );
      return settle("contact_not_found");
    }
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
      // A booking.* workflow may be pinned to one booking page. Unset =
      // any page (also what a manual, non-booking-page event's absent
      // `bookingPageSlug` context always fails to match against).
      if (
        BOOKING_TRIGGERS.has(wf.trigger.type) &&
        wf.trigger.bookingPageSlug &&
        wf.trigger.bookingPageSlug !== input.context?.bookingPageSlug
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
      // After the narrowing and filters: only a workflow that would take the
      // contact can be a steps change (another page's workflow isn't one).
      if (
        input.expectedStepsFingerprints &&
        input.expectedStepsFingerprints[wf.id] !== workflowStepsFingerprint(wf)
      ) {
        // The approved action's result was already returned: the log is the record.
        console.warn(`[workflows] ${wf.id} not started for ${input.type}: not the steps the approver reviewed`);
        skip("steps_changed");
        continue;
      }
      if (agentHold.shouldHold(input)) {
        // Fails closed per workflow: never enrol, and tell the agent.
        const fail = (reason: HoldFailure["reason"]) => {
          (outcome.holdFailures ??= []).push({ workflowId: wf.id, reason });
          skip(reason === "reentry_check_failed" ? "reentry_check_failed" : "hold_refused");
        };
        // Obviously-blocked workflows produce no proposal; approve re-runs
        // the real re-entry check inside its run-creating transaction.
        let blocked: boolean;
        try {
          blocked = await reentryWouldBlock(wf, contact.id);
        } catch (err) {
          console.error("[workflows] re-entry probe failed — not holding", err);
          fail("reentry_check_failed");
          continue;
        }
        if (blocked) {
          skip("reentry_blocked");
          continue;
        }
        let held: HeldEnrolment | null;
        try {
          held = await writeHeldEnrolment(input, wf, contact);
        } catch (err) {
          console.error("[workflows] held enrolment write failed — not enrolling", err);
          fail("hold_error");
          continue;
        }
        if (!held) {
          fail("hold_refused");
          continue;
        }
        (outcome.held ??= []).push(held);
        continue;
      }
      const run = await enroll(wf, contact.id, input.context ?? {}, true);
      if (typeof run === "string") {
        skip(run);
        continue;
      }
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

const isLive = (d: { data: () => unknown }) => {
  const s = (d.data() as WorkflowRunDoc).status;
  return s === "running" || s === "waiting";
};

/**
 * Read-only probe of the re-entry policy — the same reads createRunUnlessBlocked
 * makes (the runs query, the lock, its lastRunId run), without the writes.
 */
async function reentryWouldBlock(wf: WorkflowDoc, contactId: string): Promise<boolean> {
  const policy = wf.reentry ?? "every_time";
  if (policy === "every_time") return false;
  const db = getAdminDb();
  const runs = await db
    .collection("workflowRuns")
    .where("workflowId", "==", wf.id)
    .where("contactId", "==", contactId)
    .get();
  if (!runs.empty && (policy === "once_ever" || runs.docs.some(isLive))) return true;
  const lock = await db.doc(`workflowEnrolmentLocks/${wf.id}_${contactId}`).get();
  if (!lock.exists) return false;
  if (policy === "once_ever") return true;
  const lastRunId = (lock.data() as { lastRunId?: string }).lastRunId;
  if (!lastRunId) return false;
  const last = await db.doc(`workflowRuns/${lastRunId}`).get();
  return last.exists && isLive(last);
}

/** The per-(workflow, contact) enrolment lock. EVERY run creation writes it
 *  in the same atomic write as the run — see createRunUnlessBlocked. */
function enrolmentLock(wf: WorkflowDoc, contactId: string, runId: string) {
  return {
    ref: getAdminDb().doc(`workflowEnrolmentLocks/${wf.id}_${contactId}`),
    data: {
      workflowId: wf.id,
      contactId,
      subAccountId: wf.subAccountId,
      agencyId: wf.agencyId,
      lastRunId: runId,
      updatedAt: FieldValue.serverTimestamp(),
    },
  };
}

/**
 * Create the run doc only if the workflow's re-enrollment policy allows it —
 * the check and the create in ONE transaction, so simultaneous triggers (three
 * inbound messages, three webhooks) cannot all pass a check none has yet
 * written past.
 *
 * Invariant: every run creation — this path, every_time and test enrolments
 * alike — writes the per-(workflow, contact) lock doc atomically with the
 * run. The transaction reads that lock, so any run created concurrently
 * conflicts on it and the transaction re-runs, now seeing it as the lock's
 * `lastRunId`. "once_ever" blocks once the lock exists; "unless_active"
 * blocks while the `lastRunId` run is live.
 *
 * The transaction reads ONLY document refs, never a query. The server SDK
 * locks pessimistically, and a `workflowRuns where workflowId == X` query
 * locks an index range shared by EVERY contact of workflow X — which each
 * enrolment then writes into. A bulk tag-add on 41 contacts made all 41
 * contend on that one range and 19 exhausted their retries (2026-09-24).
 *
 * The `workflowRuns` query BEFORE the transaction covers only runs the lock
 * cannot show: runs from before lock docs existed, and earlier runs whose
 * `lastRunId` was since overwritten (a live run, then a newer test run).
 * Those are not racing us, so a plain read is enough.
 *
 * Fails CLOSED: an error here skips the enrolment rather than risk the
 * duplicate auto-reply the policy exists to prevent.
 */
async function createRunUnlessBlocked(
  wf: WorkflowDoc,
  contactId: string,
  policy: "unless_active" | "once_ever",
  runRef: FirebaseFirestore.DocumentReference,
  runData: Record<string, unknown>
): Promise<"created" | "reentry_blocked" | "reentry_check_failed"> {
  const db = getAdminDb();
  const lock = enrolmentLock(wf, contactId, runRef.id);
  try {
    const runs = await db
      .collection("workflowRuns")
      .where("workflowId", "==", wf.id)
      .where("contactId", "==", contactId)
      .get();
    if (!runs.empty && (policy === "once_ever" || runs.docs.some(isLive))) {
      return "reentry_blocked";
    }
    return await db.runTransaction(async (tx) => {
      const lockSnap = await tx.get(lock.ref);
      if (lockSnap.exists) {
        if (policy === "once_ever") return "reentry_blocked" as const;
        const lastRunId = (lockSnap.data() as { lastRunId?: string }).lastRunId;
        if (lastRunId) {
          const last = await tx.get(db.doc(`workflowRuns/${lastRunId}`));
          if (last.exists && isLive(last)) return "reentry_blocked" as const;
        }
      }
      tx.set(lock.ref, lock.data);
      tx.set(runRef, runData);
      return "created" as const;
    });
  } catch (err) {
    console.error("[workflows] re-entry transaction failed — not enrolling", err);
    return "reentry_check_failed";
  }
}

/** `applyReentry` = enforce the workflow's re-enrollment policy (test
 *  enrolments bypass it). Returns the skip reason when not enrolled. */
async function enroll(
  wf: WorkflowDoc,
  contactId: string,
  context: Record<string, unknown>,
  applyReentry = false
): Promise<
  { runId: string; status: "running" | "failed" } | "reentry_blocked" | "reentry_check_failed"
> {
  const db = getAdminDb();
  const runRef = db.collection("workflowRuns").doc();
  const runData = {
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
  };
  const policy = applyReentry ? (wf.reentry ?? "every_time") : "every_time";
  if (policy === "every_time") {
    const lock = enrolmentLock(wf, contactId, runRef.id);
    await db.batch().set(lock.ref, lock.data).set(runRef, runData).commit();
  } else {
    const created = await createRunUnlessBlocked(wf, contactId, policy, runRef, runData);
    if (created !== "created") return created;
  }
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

/** Returns false when the step was not published: the run is no longer live
 *  (nothing written), or the publish failed (run marked failed). */
async function scheduleNode(
  runRef: FirebaseFirestore.DocumentReference,
  nodeId: string,
  delaySeconds: number,
  run: RunActivityRun,
  wf: WorkflowDoc | null,
  deduplicationId = `wf_${runRef.id}_${nodeId}`
): Promise<boolean> {
  // State BEFORE the publish: an immediate step can be delivered and finish
  // before publishCallback returns, and a write after it would drag a run that
  // step parked ("waiting" on a reply) or finished ("completed") back here.
  // Conditional: a run failed meanwhile (the step route's final retry) or
  // otherwise ended is never resurrected, and nothing more is published.
  const live = await getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(runRef);
    const status = (snap.data() as WorkflowRunDoc | undefined)?.status;
    if (status !== "running" && status !== "waiting") return false;
    tx.update(runRef, {
      currentNodeId: nodeId,
      status: delaySeconds > 0 ? "waiting" : "running",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
  if (!live) return false;
  const res = await publishCallback({
    pathname: STEP_PATH,
    body: { runId: runRef.id, nodeId },
    delaySeconds,
    deduplicationId,
    retries: WORKFLOW_STEP_RETRIES,
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
  await runRef.update({ qstashMessageId: res.messageId });
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

/**
 * Steps that message a contact run AT MOST ONCE. The history entry is written
 * after the send, so on its own it cannot stop a second delivery that arrives
 * mid-step, or one that follows a failed history write or a crash. These
 * steps are claimed first; a claim without its history entry is never re-run
 * — the delivery throws, and its final retry fails the run with the reason
 * (failRunAfterFinalRetry) rather than risk messaging the contact twice.
 */
const AT_MOST_ONCE_NODES = new Set<WorkflowNodeType>([
  "send_email",
  "send_sms",
  "whatsapp_template",
  "send_whatsapp",
]);

/**
 * Claim a step for this delivery. False = nothing to do (the run moved on or
 * the step is already recorded). Throws when another delivery holds the claim:
 * it may still be sending, or may have died after sending — either way this
 * one must not send, and a 5xx lets QStash look again later.
 */
async function claimStep(
  runRef: FirebaseFirestore.DocumentReference,
  nodeId: string
): Promise<boolean> {
  return getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(runRef);
    if (!snap.exists) return false;
    const r = snap.data() as WorkflowRunDoc;
    if (r.status !== "running" && r.status !== "waiting") return false;
    if (r.history.some((h) => h.nodeId === nodeId)) return false;
    if (r.stepClaim?.nodeId === nodeId) {
      throw new Error(
        `step ${nodeId} is already claimed by an earlier delivery that did not finish; not re-run so the contact is not messaged twice`
      );
    }
    tx.update(runRef, {
      stepClaim: { nodeId, state: "sending", at: Timestamp.now() },
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

/**
 * The step route's last word on a delivery that kept throwing: QStash will not
 * retry it again, so without this the run would sit "running" forever (and
 * block `unless_active` re-entry). Marks it failed with the reason, unless it
 * finished or moved on meanwhile. Never throws.
 */
export async function failRunAfterFinalRetry(
  runId: string,
  nodeId: string,
  err: unknown
): Promise<void> {
  try {
    const db = getAdminDb();
    const runRef = db.collection("workflowRuns").doc(runId);
    const failed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(runRef);
      if (!snap.exists) return null;
      const r = snap.data() as WorkflowRunDoc;
      if (r.status !== "running" && r.status !== "waiting") return null;
      if (r.history.some((h) => h.nodeId === nodeId)) return null;
      tx.update(runRef, {
        status: "failed",
        ...(r.stepClaim?.nodeId === nodeId
          ? { stepClaim: { ...r.stepClaim, state: "failed" } }
          : {}),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return r;
    });
    if (!failed) return;
    const wfSnap = await db.doc(`workflows/${failed.workflowId}`).get();
    const wf = wfSnap.exists ? (wfSnap.data() as WorkflowDoc) : null;
    const type = wf?.nodes?.[nodeId]?.type ?? nodeId;
    const reason = err instanceof Error ? err.message : String(err);
    await writeRunActivity(
      { ...failed, id: runId },
      wf?.name ?? null,
      "automation_failed",
      `the ${type} step failed after every retry (${reason.slice(0, 300)})`
    );
  } catch (e) {
    console.error("[workflows] could not fail the run after its final retry", e);
  }
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
  const done = run.history.find((h) => h.nodeId === nodeId);
  if (done) {
    // QStash retry. The step ran; make sure what came after it happened too.
    await redriveAfter(runRef, run, done);
    return;
  }

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
  const foreign =
    contactSnap.exists && contactSnap.data()?.subAccountId !== run.subAccountId;
  if (foreign) {
    console.warn(
      `[workflows] run ${runId} failed: contact ${run.contactId} is not in sub-account ${run.subAccountId}`,
    );
  }
  if (!contactSnap.exists || foreign) {
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
  const atMostOnce = AT_MOST_ONCE_NODES.has(node.type);
  if (atMostOnce && !(await claimStep(runRef, nodeId))) return;
  const exec = REGISTRY[node.type] ?? execPassThrough;
  const stepCtx: NodeContext = {
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
    selfTriggeredBookingAt: selfTriggeredBookingAt(wf, run),
  };
  let executed: Awaited<ReturnType<NodeExecutor>>;
  try {
    // Prospecting approach guard: past the opt-out / no-address skip, before
    // the send. Refuses (ends the run), holds (daily cap) or stamps + sends.
    // Throws on an infrastructure error: claim released, nothing sent.
    const refused =
      atMostOnce && !sendSkips(node.type, contact)
        ? await guardProspectSend({
            contactId: contact.id,
            subAccountId: run.subAccountId,
            agencyId: run.agencyId,
            subAccount,
            workflowId: run.workflowId,
            runId,
            nodeId,
          })
        : null;
    executed = refused ?? (await exec(stepCtx));
  } catch (err) {
    // Thrown before any provider call (`sent` is set just before one): nothing
    // went out, so release the claim and let QStash retry normally. Once a
    // provider call has started the claim stays — at most once.
    if (atMostOnce && !stepCtx.sent) {
      await runRef.update({ stepClaim: null }).catch((releaseErr: unknown) =>
        console.error("[workflows] step claim release failed", releaseErr)
      );
    }
    throw err;
  }
  const { result, log } = executed;

  // Quiet hours: nothing was sent, so no history entry (that would mark the
  // step done). Release the claim and run this same step again when they end.
  // Keyed on the window's end, so a redelivery of this defer is one publish
  // and one timeline row, not one per delivery.
  // The prospecting daily first-touch cap takes the same path to tomorrow.
  if (result.kind === "defer") {
    const { hold } = result;
    const cap = log === APPROACH_CAP_LOG;
    const key = `${runId}_${nodeId}_${cap ? "cap" : "qh"}_${hold.until.getTime()}`;
    if (atMostOnce) await runRef.update({ stepClaim: null });
    await writeHoldActivity(
      contact.id,
      cap
        ? `Workflow step (${node.type}) held: today's prospect first-touch cap is reached; it goes out at ${formatHoldUntil(hold)}.`
        : `Workflow step (${node.type}) held for quiet hours; it goes out at ${formatHoldUntil(hold)}.`,
      `qh_${key}`,
    );
    await scheduleNode(runRef, nodeId, hold.retryAfterSec, run, wf, `wf_${key}`);
    return;
  }

  // Where control goes next, decided now and kept on the history entry, so a
  // redelivery that finds this step done can re-drive a next step that was
  // never scheduled (redriveAfter). A failed step has nowhere to go.
  let target: string | null = null;
  let delay = 0;
  if (result.kind === "branch") {
    const b = node.branches;
    target = (result.value ? b?.whenTrue : b?.whenFalse) ?? null;
  } else if (result.kind === "wait") {
    target = node.next ?? null;
    delay = result.seconds;
  } else if (result.kind === "next") {
    target = node.next ?? null;
  }
  const entry: WorkflowRunHistoryEntry = {
    nodeId,
    type: node.type,
    at: Timestamp.now(),
    result: log,
    ...(result.kind === "fail" ? {} : { advance: { to: target, delaySeconds: delay } }),
  };
  await runRef.update({
    history: FieldValue.arrayUnion(entry),
    ...(atMostOnce ? { stepClaim: null } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  });
  // A review ask is logged once, here — after the history entry above, the
  // step's idempotency marker, so nothing sits between the send and the
  // marker. Sent, or failed after a provider was called; a skipped step, or
  // one refused before sending, is not a request.
  const failed = log.startsWith("error:");
  if (stepCtx.sent && !log.startsWith("skipped:") && (!failed || stepCtx.sent.attempted)) {
    await logIfReviewAsk({
      sub: subAccount,
      agencyId: run.agencyId,
      subAccountId: run.subAccountId,
      contactId: contact.id,
      channel: stepCtx.sent.channel,
      source: "workflow",
      parts: stepCtx.sent.parts,
      template: stepCtx.sent.template,
      templateValues: stepCtx.sent.templateValues,
      createdByUid: "workflow",
      outcome: failed
        ? { ok: false, failureKind: log.slice("error:".length) }
        : { ok: true, messageSid: stepCtx.sent.messageSid },
    });
  }

  // Advance control flow.
  if (result.kind === "fail") {
    await runRef.update({
      status: "failed",
      updatedAt: FieldValue.serverTimestamp(),
    });
    await writeRunActivity(
      run,
      wf.name ?? null,
      "automation_failed",
      `the ${node.type} step failed (${log})`
    );
    return;
  }
  if (!target) {
    await completeRun(runRef, run, wf);
    return;
  }
  await scheduleNode(runRef, target, delay, run, wf);
}

/**
 * A redelivery of a step that is already in history. Normally a no-op; but if
 * the delivery that recorded it died before the next step was scheduled (the
 * pre-publish write threw, or the process stopped), the run would sit "running"
 * forever. Re-drive it — only while the run still points at this step or its
 * unrecorded successor, is not parked on a reply, and that successor is not
 * mid-send. The publish's deduplication id, the step worker's history guard and
 * the send claim make a re-drive of a step that WAS scheduled harmless.
 */
async function redriveAfter(
  runRef: FirebaseFirestore.DocumentReference,
  run: WorkflowRunDoc,
  entry: WorkflowRunHistoryEntry
): Promise<void> {
  const adv = entry.advance;
  if (!adv || run.waiting) return;
  if (run.currentNodeId !== entry.nodeId && run.currentNodeId !== adv.to) return;
  if (adv.to && run.history.some((h) => h.nodeId === adv.to)) return;
  if (adv.to && run.stepClaim?.nodeId === adv.to) return;
  const wfSnap = await getAdminDb().doc(`workflows/${run.workflowId}`).get();
  const wf = wfSnap.exists ? (wfSnap.data() as WorkflowDoc) : null;
  if (!adv.to) {
    await completeRun(runRef, run, wf);
    return;
  }
  const at = (entry.at as Timestamp | null)?.toMillis?.() ?? Date.now();
  const remaining = Math.max(0, adv.delaySeconds - Math.floor((Date.now() - at) / 1000));
  await scheduleNode(runRef, adv.to, remaining, run, wf);
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
      retries: WORKFLOW_STEP_RETRIES,
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
      advance: { to: node.branches?.whenFalse ?? null, delaySeconds: 0 },
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
