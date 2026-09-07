import { WorkflowBuilderLoader } from "@/components/workflows/workflow-builder-loader";
import type {
  BuilderReadiness,
  WhatsappSenderOption,
} from "@/components/workflows/workflow-builder";
import { getAdminDb } from "@/lib/firebase/admin";
import { agencyAllowsSharedSms } from "@/lib/agency/policy";
import { emailIsConfigured, tenantFrom } from "@/lib/comms/resend";
import {
  smsIsConfigured,
  subAccountTwilioIsConfigured,
} from "@/lib/comms/twilio";
import type { SubAccountDoc } from "@/types";
import { whatsappSenderConfigured } from "@/lib/comms/whatsapp/sender-configured";
import { capabilitiesFor } from "@/lib/comms/whatsapp/provider";
import {
  listWhatsappSenders,
  resolveWhatsappSender,
} from "@/lib/comms/whatsapp/resolve-sender";

export const dynamic = "force-dynamic";

export default async function WorkflowBuilderPage({
  params,
}: {
  params: Promise<{ subAccountId: string; workflowId: string }>;
}) {
  const { subAccountId, workflowId } = await params;

  // Resolve integration configuration server-side. The builder applies the
  // template requirement only to template-send nodes. Runtime checks still
  // validate the selected sender, recipient, and any reply-window restrictions.
  const db = getAdminDb();
  const [snap, approvedWhatsapp] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}`).get(),
    // Template-send nodes need an approved template; free-form sends do not.
    db
      .collection(`subAccounts/${subAccountId}/whatsappTemplates`)
      .where("status", "==", "approved")
      .limit(1)
      .get(),
  ]);
  const sub = snap.data() as SubAccountDoc | undefined;
  const tc = sub?.twilioConfig ?? null;

  // Each tier evaluated separately so the builder can show a green/red
  // breakdown on the node, not just the final OR/AND. The shared "agency" SMS
  // tier only counts when the env creds exist AND the agency permits sub-
  // accounts to use the shared sender.
  const smsSub = subAccountTwilioIsConfigured(tc);
  const smsAgency = smsIsConfigured() && (await agencyAllowsSharedSms(sub?.agencyId));
  const emailSub = sub?.emailProvider === "smtp" ? emailIsConfigured(sub) : tenantFrom(sub) !== undefined && emailIsConfigured();
  const emailAgency = sub?.emailProvider !== "smtp" && emailIsConfigured();
  const whatsappGate = sub?.whatsappEnabledByAgency === true;
  // Per-rail, and it must agree with executeWhatsappTemplate in the engine —
  // a builder that paints a node green for a step the run then skips is worse
  // than one that paints it red. The Twilio-shaped check refused Cloud, whose
  // templates the dispatcher supports.
  const whatsappSender = whatsappSenderConfigured(sub);
  // The rail of the sender a step with no `senderId` sends from — the same
  // resolution the engine runs, so a green node is a node that can send.
  const resolvedDefault = resolveWhatsappSender(sub);
  const whatsappRail = resolvedDefault.ok ? resolvedDefault.provider : "twilio";
  const whatsappTemplate =
    capabilitiesFor(whatsappRail).supportsTemplates && !approvedWhatsapp.empty;

  const readiness: BuilderReadiness = {
    emailReady: emailIsConfigured(sub),
    smsReady: smsSub || smsAgency,
    whatsappReady: whatsappGate && whatsappSender && whatsappTemplate,
    detail: {
      smsSub,
      smsAgency,
      emailSub,
      emailAgency,
      whatsappGate,
      whatsappSender,
      whatsappTemplate,
    },
  };

  // Only STORED senders are selectable. The synthesized one has no persisted
  // id, so offering it would write a `senderId` that stops resolving the
  // moment the workspace adds a real sender — where "account default" (an
  // empty senderId) keeps working through every registry change.
  const whatsappSenders: WhatsappSenderOption[] = (
    sub?.whatsappSenders?.length ? listWhatsappSenders(sub) : []
  ).map((s) => ({
      id: s.id,
      label: s.label,
      phoneNumber: s.phoneNumber,
      isDefault: s.isDefault === true,
    }),
  );

  return (
    <div className="mx-auto w-full max-w-5xl">
      <WorkflowBuilderLoader
        saId={subAccountId}
        workflowId={workflowId}
        readiness={readiness}
        whatsappSenders={whatsappSenders}
      />
    </div>
  );
}
