import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { qstashIsConfigured } from "@/lib/automations/qstash";
import { emailIsConfigured, tenantFrom } from "@/lib/comms/resend";
import { smsIsConfigured, subAccountTwilioIsConfigured } from "@/lib/comms/twilio";
import { capabilitiesFor } from "@/lib/comms/whatsapp/provider";
import { checkWhatsappReadiness } from "@/lib/comms/whatsapp/readiness";
import { isTemplateApprovedFor } from "@/lib/comms/whatsapp/template-registrations";
import { pushIsConfigured } from "@/lib/push/config";
import { formPublicUrl, listFormsForSubAccount } from "@/lib/server/forms-service";
import { getEffectiveQuotas, usageMonthKey } from "@/lib/server/usage-meter";
import { hasUnsettledFailure, siteDisplayName } from "@/lib/server/websites-service";
import { listWorkflows } from "@/lib/server/workflows-service";
import type { AgencyDoc, SubAccountDoc, WhatsappTemplateDoc } from "@/types";
import type { UsageMonthDoc } from "@/types/usage";
import type { WebsiteDoc } from "@/types/website";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { oneLine } from "./text-safety";
import { workflowBuilderUrl } from "./workflow-support";

/**
 * speed_to_lead_readiness (UPSTREAM_PORT_PLAN.md, STL-2): one report the
 * assistant reads before it proposes anything in the Speed-to-Lead setup, so
 * it never builds a step for a channel that cannot send.
 *
 * Each channel is asked the question the workflow engine asks at send time,
 * through the same functions: `emailIsConfigured(sub)` (the workspace's SMTP
 * mailbox, else the deployment's Resend sender), the Twilio number or the
 * shared sender the agency allows, and `checkWhatsappReadiness` for the rail
 * the workspace's default WhatsApp sender is on (Twilio, Meta Cloud or the
 * linked-device bridge). Upstream (68798611) knows Resend and Twilio only.
 *
 * READ-ONLY: Firestore reads and, for a bridge sender, the bridge's own
 * health probe. Nothing is written, seeded or migrated — every reader used
 * here is a plain read (speed-to-lead.test.ts fails on any write).
 */

const mark = (ready: boolean) => (ready ? "READY" : "NOT READY");
const MAX_LISTED = 12;
const MAX_TEMPLATES = 8;
const SETTINGS = "Settings Sub-Account → Messaging tab";

const RAIL_LABEL = { twilio: "Twilio", cloud: "Meta Cloud API", bridge: "your own number (linked device)" } as const;

/** One channel's use this month against its cap, as `checkQuota` reads it. */
function usageOf(used: number | undefined, limit: number | null | undefined, counts: boolean) {
  const cap = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
  const n = used ?? 0;
  return { used: n, cap, capped: cap !== null && n >= cap, counts };
}
type Usage = ReturnType<typeof usageOf>;
const cappedNote = (u: Usage, what: string) =>
  u.capped ? ` But this month's ${what} cap is used up${u.counts ? ` (${u.used}/${u.cap})` : ""}: those steps are skipped until the month resets or the agency raises the cap.` : "";

/** A link's page: origin + path, no trailing slash, query and hash dropped. */
function pageOf(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function emailLine(sub: SubAccountDoc, usage: Usage): { ready: boolean; line: string } {
  const configured = emailIsConfigured(sub);
  const ready = configured && !usage.capped;
  const smtp = sub.emailProvider === "smtp";
  const replyTo = oneLine(sub.replyToEmail);
  const sender = !configured
    ? smtp
      ? `this workspace is set to send through its own SMTP mailbox, but the connection isn't verified. Fix: ${SETTINGS} → Email provider. Email steps (and 'notify team' emails) fail until then.`
      : `no email sender is configured: connect the workspace's own mailbox under ${SETTINGS} → Email provider (SMTP), or the deployment sets up its shared sender (agency/setup task). Email steps (and 'notify team' emails) fail until then.`
    : smtp
      ? `sends through the workspace's own SMTP mailbox as ${oneLine(sub.smtpConfig?.fromEmail)}.`
      : tenantFrom(sub)
        ? `sends from the workspace's own verified domain ${oneLine(sub.resendConfig?.domainName)}.`
        : `sends from the platform's shared sender (the workspace can use its own mailbox or sending domain instead: ${SETTINGS} → Email provider / Email sending domain).`;
  const replies = !configured
    ? ""
    : replyTo
      ? ` Reply-To is ${replyTo}.`
      : smtp
        ? " Reply-To is not set, so replies go to the mailbox's own address."
        : ` Reply-To is NOT set, so replies to automated emails don't reach this workspace — set it under ${SETTINGS} → Sending preferences.`;
  return { ready, line: `EMAIL: ${mark(ready)} — ${sender}${replies}${configured ? cappedNote(usage, "email") : ""}` };
}

function smsLine(sub: SubAccountDoc, agency: Partial<AgencyDoc>, usage: Usage): string {
  const twilio = sub.twilioConfig ?? null;
  const dedicated = subAccountTwilioIsConfigured(twilio);
  // Only an explicit `false` disables the shared fallback (agency/policy.ts).
  const sharedAllowed = agency.sharedSmsAllowed !== false;
  const shared = !dedicated && sharedAllowed && smsIsConfigured();
  const configured = dedicated || shared;
  const detail = dedicated
    ? `dedicated Twilio number ${oneLine(twilio?.fromNumber)} (two-way threads + STOP/START handled).`
    : shared
      ? `no dedicated number; falls back to the platform's shared sender (one-way — replies can't be routed back). Fix: ${SETTINGS} → SMS → enable a dedicated Twilio number.`
      : !sharedAllowed
        ? `the agency requires each workspace to bring its own Twilio number and none is configured. Fix: ${SETTINGS} → SMS → paste the workspace's Twilio Account SID, Auth Token, and From number. Leave SMS out of the flow until then.`
        : `no Twilio number is configured anywhere. Fix: ${SETTINGS} → SMS → enable a dedicated Twilio number (or the agency sets shared Twilio keys on the deployment). Leave SMS out of the flow until then.`;
  return `SMS: ${mark(configured && !usage.capped)} — ${detail}${configured ? cappedNote(usage, "SMS") : ""}`;
}

async function whatsappLine(subAccountId: string, sub: SubAccountDoc, usage: Usage): Promise<string> {
  const out = (ready: boolean, detail: string) => `WHATSAPP: ${mark(ready)} — ${detail}`;
  // The gate first: with it off nothing sends, and no credential is read.
  if (sub.whatsappEnabledByAgency !== true) {
    return out(false, "the agency WhatsApp gate is OFF for this workspace (agency owner: Agency → Sub-accounts → Manage). Leave WhatsApp out of the flow.");
  }
  // The rail and sender a workflow step with no sender of its own goes out on.
  const wa = await checkWhatsappReadiness({ subAccountId, subAccount: sub });
  if (!wa.ready) {
    return out(false, `the gate is on, but the ${RAIL_LABEL[wa.provider]} sender can't send: ${wa.error} WhatsApp senders are connected under ${SETTINGS}. Leave WhatsApp out for now.`);
  }
  const sender = `${oneLine(wa.sender.label)}${wa.sender.phoneNumber ? ` (${oneLine(wa.sender.phoneNumber)})` : ""} on ${RAIL_LABEL[wa.provider]}`;
  if (!capabilitiesFor(wa.provider).supportsTemplates) {
    return out(
      !usage.capped,
      `sends from ${sender}. This rail has no templates and no 24-hour window: use a send_whatsapp step (plain text in config.body). Never a whatsapp_template step here — it is skipped on this rail.${cappedNote(usage, "WhatsApp")}`
    );
  }
  // Approval is per rail: a template cleared on another rail can't be sent on this one.
  const snap = await getAdminDb().collection(`subAccounts/${subAccountId}/whatsappTemplates`).get();
  const approved = snap.docs
    .map((d) => ({ id: d.id, tpl: d.data() as WhatsappTemplateDoc }))
    .filter(({ tpl }) => isTemplateApprovedFor(tpl, wa.provider));
  if (approved.length === 0) {
    return out(
      false,
      `the sender is connected (${sender}), but NO template is approved on this rail. A new lead hasn't messaged first, so only a Meta-approved template can reach them. Create one under AI Agents → WhatsApp → Templates and wait for approval; leave WhatsApp out for now.`
    );
  }
  const list = approved.slice(0, MAX_TEMPLATES).map(({ id, tpl }) => {
    const typed = (tpl.variables ?? []).filter((v) => v.source === "manual").length;
    return `“${oneLine(tpl.displayName || tpl.name) || id}” (id ${id}${typed ? `; ${typed} value${typed === 1 ? "" : "s"} typed per step — set config.manualValues or it won't send` : ""})`;
  });
  return out(
    !usage.capped,
    `sends from ${sender}. Use a whatsapp_template step (config.templateId) with an approved template: ${list.join(", ")}${approved.length > MAX_TEMPLATES ? ` (+${approved.length - MAX_TEMPLATES} more)` : ""}. A plain-text WhatsApp step can't reach a new lead on this rail.${cappedNote(usage, "WhatsApp")}`
  );
}

/** Whether THIS user gets the new-lead push, as `sendPushForEvent` decides it:
 *  an active member unless they switched the workspace off; the agency owner
 *  without a membership row only when they ticked it. */
async function pushLine(subAccountId: string, uid: string, agency: Partial<AgencyDoc>): Promise<string> {
  const db = getAdminDb();
  const [memberSnap, prefsSnap, devicesSnap] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}/subAccountMembers/${uid}`).get(),
    db.doc(`users/${uid}/settings/notifications`).get(),
    db.collection(`users/${uid}/pushSubscriptions`).get(),
  ]);
  const member = memberSnap.data()?.status === "active";
  const pref = (prefsSnap.data()?.subAccounts as Record<string, boolean> | undefined)?.[subAccountId];
  const wanted = member ? pref !== false : agency.ownerUid === uid && pref === true;
  const devices = devicesSnap.size;
  const configured = pushIsConfigured();
  const where = "top-right account menu → Your account → Notifications";
  const detail = !configured
    ? "push notifications aren't set up on this deployment (agency/setup task: VAPID keys + redeploy). Rely on the 'notify team' email step instead."
    : devices === 0
      ? `you have no device enabled yet. Turn it on: ${where} → allow the browser prompt → tick this workspace. On iPhone/iPad, first add the app to the Home Screen (Share → Add to Home Screen), open it from there, then enable. Each phone/computer is enabled separately.`
      : !wanted
        ? member
          ? `you have ${devices} device${devices === 1 ? "" : "s"} enabled but THIS workspace is switched off in your Notifications settings — tick it under ${where}.`
          : `you have ${devices} device${devices === 1 ? "" : "s"} enabled, but the agency owner is only alerted for workspaces they tick — tick this one under ${where}.`
        : `on for ${devices} device${devices === 1 ? "" : "s"} — you'll get a push the moment a lead comes in (new lead, inbound message, booking, missed call).`;
  return `NEW-LEAD PUSH ALERTS (you): ${mark(configured && devices > 0 && wanted)} — ${detail}`;
}

export const SPEED_TO_LEAD_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "speed_to_lead_readiness",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    // Chat only: it reports the signed-in user's own push devices, and it
    // serves the in-app setup playbook.
    surfaces: ["chat"],
    menuLabel:
      "Check whether this workspace is ready for speed-to-lead (email, SMS, WhatsApp, forms, workflows, website)",
    description:
      "Readiness report for an instant-lead-response (speed-to-lead) setup in this workspace: whether email, SMS, and WhatsApp can actually send (and which WhatsApp step type and approved templates to use), whether delayed steps can run, who gets team notifications, which forms and form-triggered workflows already exist (with each workflow's builder link), which websites exist and what their call-to-action points at, and (for an admin) this month's usage against any caps. ALWAYS run this first when the user asks to set up speed-to-lead, an instant reply to new leads, or a form auto-response — and before proposing any SMS/WhatsApp step, so you never build a step that can't send.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check speed-to-lead readiness.",
    execute: async (ctx) => {
      const db = getAdminDb();
      const subAccountId = ctx.subAccountId!;
      const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
      if (!subSnap.exists) {
        throw new CapabilityUserError("This workspace couldn't be loaded.");
      }
      const sub = subSnap.data() as SubAccountDoc;
      const agencyId = sub.agencyId || ctx.agencyId;
      const [agencySnap, forms, workflows, siteSnap, bookingSnap, usageSnap, quotas] = await Promise.all([
        db.doc(`agencies/${agencyId}`).get(),
        listFormsForSubAccount(subAccountId),
        listWorkflows(subAccountId),
        db.collection(`subAccounts/${subAccountId}/website`).get(),
        db.collection(`subAccounts/${subAccountId}/bookingPages`).get(),
        db.doc(`subAccounts/${subAccountId}/usage/${usageMonthKey()}`).get(),
        getEffectiveQuotas(subAccountId, sub),
      ]);
      const agency = (agencySnap.data() ?? {}) as Partial<AgencyDoc>;
      const used = (usageSnap.data() ?? {}) as UsageMonthDoc;
      // Usage counts and plan caps are billing detail: shown to the people
      // who manage the workspace, not to every member.
      const seesUsage = ctx.subAccountRole === "admin" || ctx.subAccountRole === "agencyOwner";
      const usage = {
        email: usageOf(used.emailsSent, quotas?.emailsPerMonth, seesUsage),
        sms: usageOf(used.smsSegments, quotas?.smsSegmentsPerMonth, seesUsage),
        whatsapp: usageOf(used.whatsappMessages, quotas?.whatsappPerMonth, seesUsage),
      };
      const lines: string[] = [];

      const email = emailLine(sub, usage.email);
      lines.push(email.line);
      lines.push(smsLine(sub, agency, usage.sms));
      lines.push(await whatsappLine(subAccountId, sub, usage.whatsapp));

      // Queue. Without it the engine fails every run before its first step
      // (fireWorkflowTrigger), unlike upstream, where instant steps still run.
      const queue = qstashIsConfigured();
      lines.push(
        `DELAYED STEPS / QUEUE: ${mark(queue)} — ${
          queue
            ? "background queue is configured; waits, reply timeouts, and reminders will run."
            : "the deployment has no QStash configured (agency/setup task). Every workflow step is run by that queue, so every run fails at once ('scheduling is not configured') and NOTHING sends, instant or delayed. Tell the user this must be fixed before a workflow can respond to a lead."
        }`
      );

      // Team notification (the 'notify team' step is an email).
      const contactEmail = oneLine(sub.accountContact?.email);
      lines.push(
        `TEAM NOTIFICATIONS: ${
          contactEmail
            ? `business contact email is ${contactEmail} (a 'notify team' step can use it).`
            : "no business contact email is set (Settings Sub-Account → Admin tab → Account contact) — 'notify team' steps fall back to the agency owner's email, or use a custom address."
        }${email.ready ? "" : " The step is sent by email, so it needs EMAIL to be READY."}`
      );

      lines.push(await pushLine(subAccountId, ctx.uid, agency));

      // Forms
      if (forms.length === 0) {
        lines.push(
          "FORMS: none yet — create one (ask me: create_form with the 'contact' preset) or build one under Sidebar → Forms."
        );
      } else {
        lines.push(
          `FORMS (${forms.length}):\n${forms
            .slice(0, MAX_LISTED)
            .map(
              (f) =>
                `  - “${oneLine(f.name) || "(unnamed)"}”${f.enabled ? "" : " (disabled)"} — ${f.submissionCount ?? 0} submissions, id: ${f.id}, public URL: ${formPublicUrl(f.id)}`
            )
            .join("\n")}`
        );
      }

      // Existing form-triggered workflows
      const formWfs = workflows.filter((w) => w.trigger?.type === "form.submitted");
      if (formWfs.length === 0) {
        lines.push(
          "FORM-TRIGGERED WORKFLOWS: none yet — create one from the speed-to-lead template (create_workflow) pinned to the chosen form."
        );
      } else {
        lines.push(
          `FORM-TRIGGERED WORKFLOWS (${formWfs.length}) — don't create a duplicate; reuse one of these. A person tests and activates it in the builder (link given):\n${formWfs
            .slice(0, MAX_LISTED)
            .map((w) => {
              const fid = w.trigger?.formId ?? null;
              const fname = fid ? oneLine(forms.find((f) => f.id === fid)?.name) || fid : "ANY form";
              return `  - “${oneLine(w.name) || "(unnamed)"}” — ${w.status}${w.startNodeId ? "" : ", no steps"}, form: ${fname}, id: ${w.id}, builder: ${workflowBuilderUrl(subAccountId, w.id)}`;
            })
            .join("\n")}`
        );
      }
      if (sub.automationsPaused === true) {
        lines.push(
          `⚠️ 'Pause all workflows' is ON — nothing fires until it's resumed (${SETTINGS} → Sending preferences).`
        );
      }

      // Websites
      if (siteSnap.empty) {
        lines.push(
          "WEBSITE: none built here. If the client's site lives elsewhere, give them the form's embed snippet or public URL to link from the site."
        );
      } else {
        // This workspace's own pages, matched by origin + path: a link that
        // merely contains "/f/<id>" on another host is not one of them.
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
        // Live means reachable: a disabled form and an unpublished booking
        // page both answer visitors with nothing to fill in.
        const formUrl = (f: (typeof forms)[number]) => pageOf(formPublicUrl(f.id));
        const bookingUrl = (slug: string) => pageOf(`${appUrl}/b/${subAccountId}/${slug}`);
        const formPages = new Set(forms.filter((f) => f.enabled).map(formUrl));
        const bookingPages = new Set(
          bookingSnap.docs.filter((b) => b.data().status === "published").map((b) => bookingUrl(b.id))
        );
        const offlinePages = new Set([
          ...forms.filter((f) => !f.enabled).map(formUrl),
          ...bookingSnap.docs.filter((b) => b.data().status !== "published").map((b) => bookingUrl(b.id)),
        ]);
        lines.push(
          `WEBSITES (${siteSnap.size}):\n${siteSnap.docs
            .map((d) => {
              const w = d.data() as Partial<WebsiteDoc>;
              const cta = oneLine(w.config?.cta_link).slice(0, 300);
              const page = cta ? pageOf(cta) : null;
              const note = hasUnsettledFailure(w)
                ? " (its last build can still finish — it can't be re-pointed until someone uses Re-check now, or Try again, on the Website page)"
                : page && formPages.has(page)
                  ? " (already points at a form ✓)"
                  : page && bookingPages.has(page)
                    ? " (points at a booking page ✓)"
                    : page && offlinePages.has(page)
                      ? " (points at a form that is disabled or a booking page that isn't published — visitors get nothing to fill in; enable or publish it, or re-point it with update_website_cta)"
                    : cta
                      ? " (does NOT point at a form — update_website_cta can re-point it, which rebuilds the site)"
                      : "";
              return `  - “${siteDisplayName(w)}” — ${w.status}${w.liveUrl ? `, live at ${oneLine(w.liveUrl)}` : ""}; call-to-action: ${cta || "none"}${note}; id: ${d.id}`;
            })
            .join("\n")}`
        );
      }

      // Usage vs caps
      const capLine = (label: string, u: Usage) =>
        u.cap !== null
          ? `${label} ${u.used}/${u.cap}${u.capped ? " — CAPPED, that channel is paused until the month resets" : ""}`
          : `${label} ${u.used} (no cap)`;
      if (seesUsage) {
        lines.push(
          `USAGE THIS MONTH: ${[
            capLine("emails", usage.email),
            capLine("SMS", usage.sms),
            capLine("WhatsApp", usage.whatsapp),
          ].join("; ")}.`
        );
      }

      return {
        resultText: `Speed-to-lead readiness for this workspace:\n${lines.join("\n")}\nRecommended order: fix or accept the channel status above → pick or create the form → create the workflow pinned to that form (a draft) → set its steps, using only channels marked READY → send the user to the workflow's builder link to check the steps, press Test and then Activate (you can do neither) → then point the website's call-to-action at the form (or share the embed snippet) → make sure the team's new-lead push alerts are on.`,
        ...(forms.length > MAX_LISTED || formWfs.length > MAX_LISTED ? { truncated: true as const } : {}),
      };
    },
  },
];
