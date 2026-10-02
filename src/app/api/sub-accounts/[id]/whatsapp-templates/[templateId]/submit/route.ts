import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { subAccountWhatsappIsConfigured } from "@/lib/comms/twilio";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import {
  createContentTemplate,
  submitForWhatsappApproval,
  WhatsappContentError,
} from "@/lib/comms/whatsapp/templates-api";
import { hasLinkMergeTag, toMetaTemplateName } from "@/lib/comms/whatsapp/template-validation";
import { twilioButtonProblem } from "@/lib/comms/whatsapp/twilio-buttons";
import { resolveWhatsappSender } from "@/lib/comms/whatsapp/resolve-sender";
import { buildRegistrationUpdate } from "@/lib/comms/whatsapp/template-registrations";
import { getWabaCreds } from "@/lib/comms/whatsapp/cloud-credentials";
import {
  createCloudTemplate,
  CloudTemplateError,
} from "@/lib/comms/whatsapp/cloud-templates";
import type { SubAccountDoc } from "@/types";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";
import { readSubAccountSecret } from "@/lib/server/sub-account-secrets";

export const dynamic = "force-dynamic";

/**
 * Submit a draft (or rejected/failed) WhatsApp template to Meta for approval,
 * over whichever rail this sub-account sends on.
 *
 *   twilio — Twilio is the BSP: create a Content resource, then request
 *            WhatsApp approval through it. Approval lands on Twilio's WABA.
 *   cloud  — submit directly to our own WABA over the Graph API.
 *
 * Meta makes the decision either way; only the route to it differs. Approval
 * therefore belongs to ONE rail, which is why the result is written as a
 * per-provider registration rather than a single flat status — a template
 * cleared through Twilio has never been seen by our own WABA.
 *
 * Flips the template to "pending" and schedules the first QStash approval poll.
 */

const SUBMITTABLE: ReadonlyArray<string> = ["draft", "rejected", "failed"];

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; templateId: string }> },
) {
  const { id: subAccountId, templateId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  const db = getAdminDb();
  const ref = db.doc(
    `subAccounts/${subAccountId}/whatsappTemplates/${templateId}`,
  );
  const [tplSnap, subSnap] = await Promise.all([
    ref.get(),
    db.doc(`subAccounts/${subAccountId}`).get(),
  ]);
  if (!tplSnap.exists) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }
  const tpl = tplSnap.data() as WhatsappTemplateDoc;
  const sub = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;

  if (sub?.whatsappEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "WhatsApp is disabled for this sub-account by your agency." },
      { status: 403 },
    );
  }
  // The rail of the sender this workspace SENDS on, resolved by the same
  // function the send path uses. Reading `whatsappProvider` here instead would
  // submit a template for approval on one rail while dispatch sends it on
  // another — approval belongs to a WABA, so the send then fails at Meta.
  const submitOn = resolveWhatsappSender(sub);
  if (!submitOn.ok) {
    return NextResponse.json({ error: submitOn.error }, { status: 400 });
  }
  const { provider } = submitOn;
  if (provider === "bridge") {
    return NextResponse.json(
      {
        error:
          "The WhatsApp bridge provider has no templates. Switch this workspace to Twilio or Cloud.",
      },
      { status: 400 },
    );
  }
  if (provider === "twilio" && (!subAccountWhatsappIsConfigured(sub?.twilioConfig) || !sub?.twilioConfig)) {
    return NextResponse.json(
      {
        error:
          "Configure a WhatsApp sender under Settings → SMS before submitting templates.",
      },
      { status: 400 },
    );
  }
  // A link filled in per contact has no fixed URL for Meta to approve. Such a
  // template is only ever sent free inside the 24-hour window.
  if (hasLinkMergeTag(tpl.buttons ?? [])) {
    return NextResponse.json(
      {
        error:
          "This template's link is filled in for each contact, so it can't be submitted for approval. It sends free inside the 24-hour window as it is.",
      },
      { status: 400 },
    );
  }
  // Twilio's button rules are narrower than Meta's (one action type per
  // template, 20-character titles). Refuse here, before anything is created,
  // with a message the operator can act on.
  const twilioProblem =
    provider === "twilio" ? twilioButtonProblem(tpl.buttons ?? []) : null;
  if (twilioProblem) {
    return NextResponse.json({ error: twilioProblem }, { status: 400 });
  }
  if (!SUBMITTABLE.includes(tpl.status)) {
    return NextResponse.json(
      { error: `A ${tpl.status} template can't be submitted again.` },
      { status: 409 },
    );
  }

  const name = toMetaTemplateName(tpl.displayName);
  const variablesSample: Record<string, string> = {};
  for (const v of tpl.variables) {
    variablesSample[String(v.position)] = v.sampleValue;
  }

  // Optimistic state so a slow Twilio round-trip shows as in-progress. Only
  // onto the doc as read, since the provider gets the content read here; once
  // it says "submitting", edits are refused.
  try {
    await ref.update(
      {
        status: "submitting",
        name,
        rejectionReason: null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { lastUpdateTime: tplSnap.updateTime },
    );
  } catch (err) {
    if ((err as { code?: unknown }).code === 9) {
      return NextResponse.json(
        { error: "The template changed while saving. Reload and try again." },
        { status: 409 },
      );
    }
    throw err;
  }

  let externalId: string;
  try {
    if (provider === "cloud") {
      const creds = await getWabaCreds(subAccountId);
      const created = await createCloudTemplate(creds, {
        name,
        language: tpl.language,
        category: tpl.category,
        body: tpl.body,
        variables: tpl.variables,
        buttons: tpl.buttons ?? [],
      });
      externalId = created.id;
    } else {
      const authToken = await readSubAccountSecret(subAccountId, "twilio", sub.twilioConfig);
      const created = await createContentTemplate({
        accountSid: sub.twilioConfig!.accountSid,
        authToken,
        friendlyName: name,
        language: tpl.language,
        body: tpl.body,
        variables: variablesSample,
        buttons: tpl.buttons ?? [],
      });
      externalId = created.contentSid;
      await submitForWhatsappApproval({
        accountSid: sub.twilioConfig!.accountSid,
        authToken,
        contentSid: externalId,
        name,
        category: tpl.category,
      });
    }
  } catch (err) {
    const detail =
      err instanceof WhatsappContentError
        ? `${err.message} (${err.status})${err.body ? `: ${err.body.slice(0, 300)}` : ""}`
        : err instanceof CloudTemplateError
          ? `${err.message} (${err.status})`
          : err instanceof Error
            ? err.message
            : "Unknown error";
    await ref.update({
      status: "failed",
      rejectionReason: detail,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json(
      { error: `Submission failed: ${detail}` },
      { status: 502 },
    );
  }

  await ref.update({
    ...buildRegistrationUpdate(tpl, provider, {
      externalId,
      status: "pending",
      rejectionReason: null,
      pollAttempts: 0,
    }),
    name,
    lastSyncedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Schedule the first approval poll. If QStash isn't configured the template
  // stays "pending" until the operator re-submits — log so it's diagnosable.
  if (qstashIsConfigured()) {
    const queued = await publishCallback({
      pathname: `/api/sub-accounts/${subAccountId}/whatsapp-templates/poll`,
      body: { subAccountId, templateId, contentSid: externalId },
      delaySeconds: 20,
      deduplicationId: `watpl_${subAccountId}_${templateId}_0`,
    });
    // publishCallback never throws: null means the poll was not queued (e.g.
    // the daily cap). `pending` can't be escaped in the UI, so park it as
    // `failed` (re-submittable) with the reason.
    if (!queued) {
      console.error(
        `[whatsapp-templates/submit] first poll not queued sa=${subAccountId} template=${templateId}`,
      );
      await ref.update({
        status: "failed",
        rejectionReason:
          "Submitted, but the approval check could not be scheduled. Re-submit the template to retry.",
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  } else {
    console.warn(
      `[whatsapp-templates/submit] QStash not configured — template ${templateId} won't auto-sync approval status`,
    );
  }

  const updated = await ref.get();
  return NextResponse.json({ ok: true, template: { id: ref.id, ...updated.data() } });
}
