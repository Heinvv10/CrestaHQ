"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Bot,
  CalendarSync,
  FlaskConical,
  Globe,
  CreditCard,
  KeyRound,
  Loader2,
  Mail,
  MapPin,
  MessageCircle,
  MessageSquareText,
  MessagesSquare,
  MonitorPlay,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Radar,
  Send,
  Share2,
  GraduationCap,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GET_LEADS_PARKED } from "@/lib/get-leads/business-types";
import { SubAccountBillingSection } from "@/components/agency/sub-account-billing-section";
import { SubAccountUsageSection } from "@/components/agency/sub-account-usage-section";
import { effectiveBillingState } from "@/lib/billing/status";
import type { SubAccountDoc } from "@/types";

/**
 * Agency-side per-sub-account management dialog. Hosts the agency-only
 * feature gates — controls the sub-account admin can't flip for themselves.
 * Opened from the agency sub-accounts list.
 *
 * Current gates:
 *   - Dedicated email sending domain (Resend slot per sub-account)
 *   - Public API access (REST + webhooks for /api/v1/*)
 *   - Broadcasts / Outbound AI calling / WhatsApp
 *   - Facebook + Instagram inbox (beta) — master switch, off by default
 *
 * Only visible to the agency owner (the list page gates rendering).
 * Disabling the email gate tears down the verified Resend domain; the API
 * gate keeps keys + subscriptions intact (so re-enabling resumes them
 * without re-rotating Zapier integrations). The dialog surfaces a warning
 * for the email tear-down only.
 */

interface Props {
  subAccount: SubAccountDoc | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SubAccountManageDialog({
  subAccount,
  open,
  onOpenChange,
}: Props) {
  const initialEmail = subAccount?.emailDomainEnabledByAgency === true;
  const initialApi = subAccount?.apiAccessEnabledByAgency === true;
  const initialBroadcasts = subAccount?.broadcastsEnabledByAgency === true;
  const initialOutbound = subAccount?.outboundVoiceEnabledByAgency === true;
  const initialWhatsapp = subAccount?.whatsappEnabledByAgency === true;
  // Default ON (opt-out) — legacy/undefined docs read as enabled so the
  // checkbox reflects the historical always-on behavior. Only an explicit
  // `false` shows unchecked. See gates.ts / SubAccountDoc docs.
  const initialSmsAgent = subAccount?.smsAgentEnabledByAgency !== false;
  const initialWebChat = subAccount?.webChatEnabledByAgency !== false;
  const initialInboundVoice = subAccount?.inboundVoiceEnabledByAgency !== false;
  const initialMetaInbox = subAccount?.metaInboxEnabledByAgency === true;
  const initialMetaAgent = subAccount?.metaAgentEnabledByAgency === true;
  const initialWebsite = subAccount?.websiteEnabledByAgency === true;
  const initialSocial = subAccount?.socialPlannerEnabledByAgency === true;
  const initialCommunity = subAccount?.communityEnabledByAgency === true;
  const initialMissedCall =
    subAccount?.missedCallTextBackEnabledByAgency === true;
  const initialPayments = subAccount?.paymentsEnabledByAgency === true;
  // Unset → hidden (the default for every hide-override).
  const initialPaymentsHidden =
    subAccount?.paymentsHiddenWhenDisabled !== false;
  const initialWebinar1 = subAccount?.webinar1EnabledByAgency === true;
  const initialWebinar1Hidden =
    subAccount?.webinar1HiddenWhenDisabled !== false;
  const initialGoogle = subAccount?.googleEnabledByAgency === true;
  const initialGoogleCalendar =
    subAccount?.googleCalendarEnabledByAgency === true;
  const initialReviewsAi = subAccount?.reviewsAiEnabledByAgency === true;
  // Workspace Assistant is opt-in like every other gate — off unless
  // explicitly enabled (legacy/unset reads as off).
  const initialAiSuite = subAccount?.aiSuiteEnabledByAgency === true;
  // Model tier for the Workspace Assistant — unset/legacy reads as Opus
  // (matches pre-picker behavior; Sonnet is the opt-down for cost).
  const initialAiSuiteModel: "opus" | "sonnet" =
    subAccount?.aiSuiteModel === "sonnet" ? "sonnet" : "opus";
  const initialLabs = subAccount?.labsEnabledByAgency === true;
  const initialGetLeads = subAccount?.getLeadsEnabledByAgency === true;
  // "Hide vs. show as Locked" flag for the sidebar-gated features. HIDDEN is the
  // default — a disabled feature is omitted from the tenant's sidebar unless the
  // owner explicitly opts it into the greyed "Locked" row (field set to `false`).
  // Read `!== false` so unset docs default to hidden.
  const initialBroadcastsHidden =
    subAccount?.broadcastsHiddenWhenDisabled !== false;
  const initialWebsiteHidden = subAccount?.websiteHiddenWhenDisabled !== false;
  const initialSocialHidden =
    subAccount?.socialPlannerHiddenWhenDisabled !== false;
  const initialCommunityHidden =
    subAccount?.communityHiddenWhenDisabled !== false;
  const initialGetLeadsHidden =
    subAccount?.getLeadsHiddenWhenDisabled !== false;
  const initialAiSuiteHidden = subAccount?.aiSuiteHiddenWhenDisabled !== false;
  const initialLabsHidden = subAccount?.labsHiddenWhenDisabled !== false;
  const hasLiveDomain = !!subAccount?.resendConfig;
  const [emailDomainEnabled, setEmailDomainEnabled] = useState(initialEmail);
  const [apiAccessEnabled, setApiAccessEnabled] = useState(initialApi);
  const [broadcastsEnabled, setBroadcastsEnabled] = useState(initialBroadcasts);
  const [outboundVoiceEnabled, setOutboundVoiceEnabled] =
    useState(initialOutbound);
  const [whatsappEnabled, setWhatsappEnabled] = useState(initialWhatsapp);
  const [smsAgentEnabled, setSmsAgentEnabled] = useState(initialSmsAgent);
  const [webChatEnabled, setWebChatEnabled] = useState(initialWebChat);
  const [inboundVoiceEnabled, setInboundVoiceEnabled] =
    useState(initialInboundVoice);
  const [metaInboxEnabled, setMetaInboxEnabled] = useState(initialMetaInbox);
  const [metaAgentEnabled, setMetaAgentEnabled] = useState(initialMetaAgent);
  const [websiteEnabled, setWebsiteEnabled] = useState(initialWebsite);
  const [socialPlannerEnabled, setSocialPlannerEnabled] =
    useState(initialSocial);
  const [communityEnabled, setCommunityEnabled] = useState(initialCommunity);
  const [paymentsEnabled, setPaymentsEnabled] = useState(initialPayments);
  const [paymentsHidden, setPaymentsHidden] = useState(initialPaymentsHidden);
  const [webinar1Enabled, setWebinar1Enabled] = useState(initialWebinar1);
  const [webinar1Hidden, setWebinar1Hidden] = useState(initialWebinar1Hidden);
  const [googleEnabled, setGoogleEnabled] = useState(initialGoogle);
  const [reviewsAiEnabled, setReviewsAiEnabled] = useState(initialReviewsAi);
  const [googleCalendarEnabled, setGoogleCalendarEnabled] = useState(
    initialGoogleCalendar
  );
  const [missedCallEnabled, setMissedCallEnabled] = useState(initialMissedCall);
  const [aiSuiteEnabled, setAiSuiteEnabled] = useState(initialAiSuite);
  const [aiSuiteModel, setAiSuiteModel] = useState<"opus" | "sonnet">(
    initialAiSuiteModel
  );
  const [labsEnabled, setLabsEnabled] = useState(initialLabs);
  const [getLeadsEnabled, setGetLeadsEnabled] = useState(initialGetLeads);
  const [broadcastsHidden, setBroadcastsHidden] = useState(
    initialBroadcastsHidden
  );
  const [websiteHidden, setWebsiteHidden] = useState(initialWebsiteHidden);
  const [socialHidden, setSocialHidden] = useState(initialSocialHidden);
  const [communityHidden, setCommunityHidden] = useState(
    initialCommunityHidden
  );
  const [getLeadsHidden, setGetLeadsHidden] = useState(initialGetLeadsHidden);
  const [aiSuiteHidden, setAiSuiteHidden] = useState(initialAiSuiteHidden);
  const [labsHidden, setLabsHidden] = useState(initialLabsHidden);
  const [saving, setSaving] = useState(false);
  // Danger-zone delete state. `deleteConfirm` must match the sub-account name
  // before the button unlocks; `deleting` disables the whole dialog mid-request.
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  // Whether the deployment has Meta app creds (META_APP_ID/SECRET). null while
  // loading. The FB/IG inbox + Social Planner gates depend on it, so they're
  // grayed out when it's false. Fetched once when the dialog first opens.
  const [metaConfigured, setMetaConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open || metaConfigured !== null) return;
    let cancelled = false;
    void fetch("/api/agency/deployment-config")
      .then((r) => r.json())
      .then((d: { metaConfigured?: boolean }) => {
        if (!cancelled) setMetaConfigured(d.metaConfigured === true);
      })
      .catch(() => {
        // On failure, don't block the agency owner — assume configured.
        if (!cancelled) setMetaConfigured(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, metaConfigured]);

  // Re-sync local state every time the dialog opens or the target sub-account
  // changes, so consecutive opens don't show stale toggle state.
  useEffect(() => {
    if (open) {
      setEmailDomainEnabled(initialEmail);
      setApiAccessEnabled(initialApi);
      setBroadcastsEnabled(initialBroadcasts);
      setOutboundVoiceEnabled(initialOutbound);
      setWhatsappEnabled(initialWhatsapp);
      setSmsAgentEnabled(initialSmsAgent);
      setWebChatEnabled(initialWebChat);
      setInboundVoiceEnabled(initialInboundVoice);
      setMetaInboxEnabled(initialMetaInbox);
      setMetaAgentEnabled(initialMetaAgent);
      setWebsiteEnabled(initialWebsite);
      setSocialPlannerEnabled(initialSocial);
      setCommunityEnabled(initialCommunity);
      setPaymentsEnabled(initialPayments);
      setPaymentsHidden(initialPaymentsHidden);
      setWebinar1Enabled(initialWebinar1);
      setWebinar1Hidden(initialWebinar1Hidden);
      setMissedCallEnabled(initialMissedCall);
      setAiSuiteEnabled(initialAiSuite);
      setAiSuiteModel(initialAiSuiteModel);
      setLabsEnabled(initialLabs);
      setGetLeadsEnabled(initialGetLeads);
      setBroadcastsHidden(initialBroadcastsHidden);
      setWebsiteHidden(initialWebsiteHidden);
      setSocialHidden(initialSocialHidden);
      setCommunityHidden(initialCommunityHidden);
      setGetLeadsHidden(initialGetLeadsHidden);
      setAiSuiteHidden(initialAiSuiteHidden);
      setLabsHidden(initialLabsHidden);
      setDeleteConfirm("");
    }
  }, [
    open,
    initialEmail,
    initialApi,
    initialBroadcasts,
    initialOutbound,
    initialWhatsapp,
    initialSmsAgent,
    initialWebChat,
    initialInboundVoice,
    initialMetaInbox,
    initialMetaAgent,
    initialWebsite,
    initialSocial,
    initialCommunity,
    initialPayments,
    initialPaymentsHidden,
    initialWebinar1,
    initialWebinar1Hidden,
    initialMissedCall,
    initialAiSuite,
    initialAiSuiteModel,
    initialLabs,
    initialGetLeads,
    initialBroadcastsHidden,
    initialWebsiteHidden,
    initialSocialHidden,
    initialCommunityHidden,
    initialGetLeadsHidden,
    initialAiSuiteHidden,
    initialLabsHidden,
    subAccount?.id,
  ]);

  if (!subAccount) return null;

  const willTearDown = initialEmail && !emailDomainEnabled && hasLiveDomain;
  const emailDirty = emailDomainEnabled !== initialEmail;
  const apiDirty = apiAccessEnabled !== initialApi;
  const broadcastsDirty = broadcastsEnabled !== initialBroadcasts;
  const outboundDirty = outboundVoiceEnabled !== initialOutbound;
  const whatsappDirty = whatsappEnabled !== initialWhatsapp;
  const smsAgentDirty = smsAgentEnabled !== initialSmsAgent;
  const webChatDirty = webChatEnabled !== initialWebChat;
  const inboundVoiceDirty = inboundVoiceEnabled !== initialInboundVoice;
  const metaInboxDirty = metaInboxEnabled !== initialMetaInbox;
  const metaAgentDirty = metaAgentEnabled !== initialMetaAgent;
  const websiteDirty = websiteEnabled !== initialWebsite;
  const socialDirty = socialPlannerEnabled !== initialSocial;
  const communityDirty = communityEnabled !== initialCommunity;
  const paymentsDirty = paymentsEnabled !== initialPayments;
  const paymentsHiddenDirty = paymentsHidden !== initialPaymentsHidden;
  const webinar1Dirty = webinar1Enabled !== initialWebinar1;
  const webinar1HiddenDirty = webinar1Hidden !== initialWebinar1Hidden;
  const googleDirty = googleEnabled !== initialGoogle;
  const googleCalendarDirty = googleCalendarEnabled !== initialGoogleCalendar;
  const reviewsAiDirty = reviewsAiEnabled !== initialReviewsAi;
  const missedCallDirty = missedCallEnabled !== initialMissedCall;
  const aiSuiteDirty = aiSuiteEnabled !== initialAiSuite;
  const aiSuiteModelDirty = aiSuiteModel !== initialAiSuiteModel;
  const labsDirty = labsEnabled !== initialLabs;
  const getLeadsDirty = getLeadsEnabled !== initialGetLeads;
  const broadcastsHiddenDirty = broadcastsHidden !== initialBroadcastsHidden;
  const websiteHiddenDirty = websiteHidden !== initialWebsiteHidden;
  const socialHiddenDirty = socialHidden !== initialSocialHidden;
  const communityHiddenDirty = communityHidden !== initialCommunityHidden;
  const getLeadsHiddenDirty = getLeadsHidden !== initialGetLeadsHidden;
  const aiSuiteHiddenDirty = aiSuiteHidden !== initialAiSuiteHidden;
  const labsHiddenDirty = labsHidden !== initialLabsHidden;
  const dirty =
    emailDirty ||
    apiDirty ||
    broadcastsDirty ||
    outboundDirty ||
    whatsappDirty ||
    smsAgentDirty ||
    webChatDirty ||
    inboundVoiceDirty ||
    metaInboxDirty ||
    metaAgentDirty ||
    websiteDirty ||
    socialDirty ||
    communityDirty ||
    paymentsDirty ||
    paymentsHiddenDirty ||
    webinar1Dirty ||
    webinar1HiddenDirty ||
    googleDirty ||
    googleCalendarDirty ||
    reviewsAiDirty ||
    missedCallDirty ||
    aiSuiteDirty ||
    aiSuiteModelDirty ||
    labsDirty ||
    getLeadsDirty ||
    broadcastsHiddenDirty ||
    websiteHiddenDirty ||
    socialHiddenDirty ||
    communityHiddenDirty ||
    getLeadsHiddenDirty ||
    aiSuiteHiddenDirty ||
    labsHiddenDirty;

  // Meta features can't work without app creds on the deployment. Gray out the
  // two Meta gates when unconfigured — but still allow turning an already-on
  // gate OFF (don't trap a legacy enabled state).
  const metaUnconfigured = metaConfigured === false;

  async function handleSave() {
    if (!subAccount) return;
    setSaving(true);
    try {
      // Only send the fields the agency owner actually changed. Keeps the
      // PATCH minimal and avoids redundant tear-down attempts when nothing
      // about email changed.
      const payload: {
        emailDomainEnabled?: boolean;
        apiAccessEnabled?: boolean;
        broadcastsEnabled?: boolean;
        outboundVoiceEnabled?: boolean;
        whatsappEnabled?: boolean;
        smsAgentEnabled?: boolean;
        webChatEnabled?: boolean;
        inboundVoiceEnabled?: boolean;
        metaInboxEnabled?: boolean;
        metaAgentEnabled?: boolean;
        websiteEnabled?: boolean;
        socialPlannerEnabled?: boolean;
        communityEnabled?: boolean;
        paymentsEnabled?: boolean;
        paymentsHiddenWhenDisabled?: boolean;
        webinar1Enabled?: boolean;
        webinar1HiddenWhenDisabled?: boolean;
        googleEnabled?: boolean;
        googleCalendarEnabled?: boolean;
        reviewsAiEnabled?: boolean;
        missedCallTextBackEnabled?: boolean;
        aiSuiteEnabled?: boolean;
        aiSuiteModel?: "opus" | "sonnet";
        labsEnabled?: boolean;
        getLeadsEnabled?: boolean;
        broadcastsHiddenWhenDisabled?: boolean;
        websiteHiddenWhenDisabled?: boolean;
        socialPlannerHiddenWhenDisabled?: boolean;
        communityHiddenWhenDisabled?: boolean;
        getLeadsHiddenWhenDisabled?: boolean;
        aiSuiteHiddenWhenDisabled?: boolean;
        labsHiddenWhenDisabled?: boolean;
      } = {};
      if (emailDirty) payload.emailDomainEnabled = emailDomainEnabled;
      if (apiDirty) payload.apiAccessEnabled = apiAccessEnabled;
      if (broadcastsDirty) payload.broadcastsEnabled = broadcastsEnabled;
      if (outboundDirty) payload.outboundVoiceEnabled = outboundVoiceEnabled;
      if (whatsappDirty) payload.whatsappEnabled = whatsappEnabled;
      if (smsAgentDirty) payload.smsAgentEnabled = smsAgentEnabled;
      if (webChatDirty) payload.webChatEnabled = webChatEnabled;
      if (inboundVoiceDirty) payload.inboundVoiceEnabled = inboundVoiceEnabled;
      if (metaInboxDirty) payload.metaInboxEnabled = metaInboxEnabled;
      if (metaAgentDirty) payload.metaAgentEnabled = metaAgentEnabled;
      if (websiteDirty) payload.websiteEnabled = websiteEnabled;
      if (socialDirty) payload.socialPlannerEnabled = socialPlannerEnabled;
      if (communityDirty) payload.communityEnabled = communityEnabled;
      if (paymentsDirty) payload.paymentsEnabled = paymentsEnabled;
      if (paymentsHiddenDirty) {
        payload.paymentsHiddenWhenDisabled = paymentsHidden;
      }
      if (webinar1Dirty) payload.webinar1Enabled = webinar1Enabled;
      if (webinar1HiddenDirty) {
        payload.webinar1HiddenWhenDisabled = webinar1Hidden;
      }
      if (googleDirty) payload.googleEnabled = googleEnabled;
      if (googleCalendarDirty) {
        payload.googleCalendarEnabled = googleCalendarEnabled;
      }
      if (reviewsAiDirty) payload.reviewsAiEnabled = reviewsAiEnabled;
      if (missedCallDirty)
        payload.missedCallTextBackEnabled = missedCallEnabled;
      if (aiSuiteDirty) payload.aiSuiteEnabled = aiSuiteEnabled;
      if (aiSuiteModelDirty) payload.aiSuiteModel = aiSuiteModel;
      if (labsDirty) payload.labsEnabled = labsEnabled;
      if (getLeadsDirty) payload.getLeadsEnabled = getLeadsEnabled;
      if (broadcastsHiddenDirty)
        payload.broadcastsHiddenWhenDisabled = broadcastsHidden;
      if (websiteHiddenDirty) payload.websiteHiddenWhenDisabled = websiteHidden;
      if (socialHiddenDirty)
        payload.socialPlannerHiddenWhenDisabled = socialHidden;
      if (communityHiddenDirty)
        payload.communityHiddenWhenDisabled = communityHidden;
      if (getLeadsHiddenDirty)
        payload.getLeadsHiddenWhenDisabled = getLeadsHidden;
      if (aiSuiteHiddenDirty) payload.aiSuiteHiddenWhenDisabled = aiSuiteHidden;
      if (labsHiddenDirty) payload.labsHiddenWhenDisabled = labsHidden;

      const res = await fetch(
        `/api/agency/sub-accounts/${subAccount.id}/feature-gates`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        clearedDomain?: boolean;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to save.");
      }
      // Build the toast message from whatever the agency owner actually
      // changed. Single message covers both toggles flipped at once.
      const parts: string[] = [];
      if (emailDirty) {
        parts.push(
          emailDomainEnabled
            ? "Email sending domain enabled."
            : data.clearedDomain
              ? "Email sending domain disabled (live domain removed, reverted to shared sender)."
              : "Email sending domain disabled."
        );
      }
      if (apiDirty) {
        parts.push(
          apiAccessEnabled
            ? "API access enabled."
            : "API access disabled. Existing keys + webhooks preserved but inert until re-enabled."
        );
      }
      if (broadcastsDirty) {
        parts.push(
          broadcastsEnabled
            ? "Broadcasts enabled."
            : "Broadcasts disabled. Historical broadcasts preserved; new sends blocked until re-enabled."
        );
      }
      if (outboundDirty) {
        parts.push(
          outboundVoiceEnabled
            ? "Outbound calling enabled."
            : "Outbound calling disabled. New calls blocked until re-enabled."
        );
      }
      if (whatsappDirty) {
        parts.push(
          whatsappEnabled
            ? "WhatsApp enabled."
            : "WhatsApp disabled. The channel goes silent; Twilio creds preserved."
        );
      }
      if (smsAgentDirty) {
        parts.push(
          smsAgentEnabled
            ? "SMS AI auto-reply enabled."
            : "SMS AI auto-reply disabled. The bot stops replying; manual SMS is unaffected."
        );
      }
      if (webChatDirty) {
        parts.push(
          webChatEnabled
            ? "Web Chat AI enabled."
            : "Web Chat AI disabled. The widget goes silent on client sites; config preserved."
        );
      }
      if (inboundVoiceDirty) {
        parts.push(
          inboundVoiceEnabled
            ? "Inbound Voice AI enabled."
            : "Inbound Voice AI disabled. The AI stops answering calls; re-enable to resume."
        );
      }
      if (metaInboxDirty) {
        parts.push(
          metaInboxEnabled
            ? "Facebook + Instagram inbox (beta) enabled."
            : "Facebook + Instagram inbox (beta) disabled. The channels go silent and hidden."
        );
      }
      if (metaAgentDirty) {
        parts.push(
          metaAgentEnabled
            ? "Messenger & Instagram AI auto-reply (beta) enabled."
            : "Messenger & Instagram AI auto-reply (beta) disabled. The bot stops replying; manual inbox replies are unaffected."
        );
      }
      if (websiteDirty) {
        parts.push(
          websiteEnabled
            ? "Website builder enabled."
            : "Website builder disabled. New builds blocked; existing site preserved."
        );
      }
      if (socialDirty) {
        parts.push(
          socialPlannerEnabled
            ? "Social Planner enabled."
            : "Social Planner disabled. Scheduled posts + Meta connection preserved."
        );
      }
      if (communityDirty) {
        parts.push(
          communityEnabled
            ? "Community enabled."
            : "Community disabled. Members, posts, and courses preserved; the public pages go offline."
        );
      }
      if (paymentsDirty) {
        parts.push(
          paymentsEnabled
            ? "Payments enabled."
            : "Payments disabled. The connected Stripe account is preserved; re-enabling resumes instantly."
        );
      }
      if (webinar1Dirty) {
        parts.push(
          webinar1Enabled
            ? "Webinars enabled."
            : "Webinars disabled. The connected webinar platform is preserved; re-enabling resumes instantly."
        );
      }
      if (googleDirty) {
        parts.push(
          googleEnabled
            ? "Google Business Profile enabled."
            : "Google Business Profile disabled. The connection is preserved; re-enabling resumes instantly."
        );
      }
      if (googleCalendarDirty) {
        parts.push(
          googleCalendarEnabled
            ? "Google Calendar sync enabled."
            : "Google Calendar sync disabled. Members' connections are preserved; re-enabling resumes instantly."
        );
      }
      if (reviewsAiDirty) {
        parts.push(
          reviewsAiEnabled
            ? "Reviews AI enabled."
            : "Reviews AI disabled. Existing sentiment labels stay; no new reviews are analysed."
        );
      }
      if (missedCallDirty) {
        parts.push(
          missedCallEnabled
            ? "Missed Call Text Back enabled."
            : "Missed Call Text Back disabled. The sub-account can no longer re-enable it."
        );
      }
      if (aiSuiteDirty) {
        parts.push(
          aiSuiteEnabled
            ? "Workspace Assistant enabled."
            : "Workspace Assistant disabled. The sidebar entry locks and the assistant is blocked for this sub-account."
        );
      }
      if (aiSuiteModelDirty) {
        parts.push(
          aiSuiteModel === "opus"
            ? "Workspace Assistant model set to Opus (default — most reliable)."
            : "Workspace Assistant model set to Sonnet (lower cost)."
        );
      }
      if (getLeadsDirty) {
        parts.push(
          getLeadsEnabled
            ? "Get Leads enabled."
            : "Get Leads disabled. New searches blocked until re-enabled."
        );
      }
      if (labsDirty) {
        parts.push(
          labsEnabled
            ? "Labs enabled — this sub-account can now try pre-release features."
            : "Labs disabled. Pre-release features are locked; nothing is torn down."
        );
      }
      // "Hide instead of lock" changes. Only meaningful while the feature is
      // off; mention the current effect so the agency owner knows what the
      // tenant will see.
      const hiddenChanges: string[] = [];
      if (broadcastsHiddenDirty)
        hiddenChanges.push(
          `Broadcasts ${broadcastsHidden ? "hidden" : "shown as Locked"}`
        );
      if (websiteHiddenDirty)
        hiddenChanges.push(
          `Website ${websiteHidden ? "hidden" : "shown as Locked"}`
        );
      if (socialHiddenDirty)
        hiddenChanges.push(
          `Social Planner ${socialHidden ? "hidden" : "shown as Locked"}`
        );
      if (communityHiddenDirty)
        hiddenChanges.push(
          `Community ${communityHidden ? "hidden" : "shown as Locked"}`
        );
      if (getLeadsHiddenDirty)
        hiddenChanges.push(
          `Get Leads ${getLeadsHidden ? "hidden" : "shown as Locked"}`
        );
      if (aiSuiteHiddenDirty)
        hiddenChanges.push(
          `Workspace Assistant ${aiSuiteHidden ? "hidden" : "shown as Locked"}`
        );
      if (labsHiddenDirty)
        hiddenChanges.push(`Labs ${labsHidden ? "hidden" : "shown as Locked"}`);
      if (hiddenChanges.length > 0) {
        parts.push(`When disabled: ${hiddenChanges.join(", ")}.`);
      }
      toast.success(parts.join(" "));
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!subAccount) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/agency/sub-accounts/${subAccount.id}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        // 409 carries the friendly "still has contacts, deals…" message.
        throw new Error(data.error ?? "Failed to delete the sub-account.");
      }
      toast.success(`Deleted ${subAccount.name}.`);
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete the sub-account."
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Manage {subAccount.name}</DialogTitle>
          <DialogDescription>
            Agency-level controls for this sub-account. Sub-account admins
            can&apos;t flip these — that&apos;s the point.
          </DialogDescription>
        </DialogHeader>

        {/* Client Billing v1 — plan assignment + checkout links. Lives above
            the gates because an assigned plan MANAGES the gates below (they
            re-apply from the plan bundle at activation and on plan edits). */}
        <SubAccountBillingSection
          subAccount={subAccount}
          disabled={saving || deleting}
        />

        {/* Usage Metering v1 — current-month usage vs quotas. Agency-eyes-
            only by design (the workspace sees only enforcement messages). */}
        <SubAccountUsageSection subAccountId={subAccount.id} />

        {(() => {
          const billingState = effectiveBillingState(subAccount.billing);
          if (billingState === "comped") return null;
          return (
            <p className="text-muted-foreground text-xs">
              This client is on a plan — the toggles below are applied from the
              plan bundle at activation and whenever the plan is edited. Manual
              changes still work but a plan edit re-applies the bundle.
            </p>
          );
        })()}

        <div className="space-y-3">
          <GateToggle
            checked={emailDomainEnabled}
            onChange={setEmailDomainEnabled}
            disabled={saving}
            icon={
              <Mail className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
            }
            title="Dedicated email sending domain"
          >
            When enabled, this sub-account can register its own subdomain so its
            email sends from its own brand. Consumes one slot on your Resend
            plan (Free = 1 domain total, Pro = 10, Scale = 1,000).
          </GateToggle>

          <GateToggle
            checked={apiAccessEnabled}
            onChange={setApiAccessEnabled}
            disabled={saving}
            icon={
              <KeyRound className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
            }
            title="Public API access"
          >
            When enabled, this sub-account can mint API keys + webhooks for
            Zapier, Make, custom landing pages, etc. Disabling immediately stops
            all <code>/api/v1/*</code> traffic from their existing keys but
            keeps the keys + subscriptions intact, so re-enabling later
            doesn&apos;t force the client to re-rotate their integrations.
          </GateToggle>

          <GateToggle
            checked={broadcastsEnabled}
            onChange={setBroadcastsEnabled}
            disabled={saving}
            icon={
              <Send className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            }
            title="Broadcasts"
            hideOption={{
              hidden: broadcastsHidden,
              onHiddenChange: setBroadcastsHidden,
              disabled: saving,
            }}
          >
            When enabled, this sub-account can send bulk email broadcasts (up to
            25,000 recipients per send) to filtered audiences. Disabling locks
            the Broadcasts sidebar entry and returns 403 on new send attempts;
            historical broadcast docs and in-flight QStash messages are
            preserved.
          </GateToggle>

          <GateToggle
            checked={websiteEnabled}
            onChange={setWebsiteEnabled}
            disabled={saving}
            icon={
              <Globe className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
            }
            title="Website"
            hideOption={{
              hidden: websiteHidden,
              onHiddenChange: setWebsiteHidden,
              disabled: saving,
            }}
          >
            When enabled, this sub-account can build and publish a marketing
            site through the website builder (gitpage.site). Builds draw on your
            agency&apos;s shared gitpage quota (30 builds/hour across all
            sub-accounts). Disabling locks the Website sidebar entry and returns
            403 on new build attempts; the existing config and any published
            site are preserved, so re-enabling resumes instantly.
          </GateToggle>

          <GateToggle
            checked={outboundVoiceEnabled}
            onChange={setOutboundVoiceEnabled}
            disabled={saving}
            icon={
              <PhoneOutgoing className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />
            }
            title="Outbound AI calling"
          >
            When enabled, this sub-account can place outbound AI voice calls to
            contacts (&quot;Call with AI&quot;). Reuses the same Vapi number as
            inbound voice. Consumes call minutes and carries compliance weight —
            a built-in gate enforces opt-out, calling hours, and rate limits,
            but you control whether the feature is available at all. Disabling
            blocks new calls; no resources are torn down.
          </GateToggle>

          <GateToggle
            checked={whatsappEnabled}
            onChange={setWhatsappEnabled}
            disabled={saving}
            icon={
              <MessageCircle className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
            }
            title="WhatsApp"
          >
            When enabled, this sub-account can turn on the WhatsApp AI channel
            (inbound auto-replies via their Twilio WhatsApp sender). Reuses the
            same Twilio credentials as SMS. Disabling silences the channel and
            makes the inbound webhook ignore this sub-account; no credentials
            are torn down, so re-enabling resumes instantly.
          </GateToggle>

          <GateToggle
            checked={smsAgentEnabled}
            onChange={setSmsAgentEnabled}
            disabled={saving}
            icon={
              <MessageSquareText className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
            }
            title="SMS AI auto-reply"
          >
            When enabled, this sub-account can turn on the AI agent that
            auto-replies to inbound SMS on its dedicated Twilio number. Each
            reply spends your agency&apos;s shared OpenRouter credits, which is
            why you control who gets it. This gates the AI bot ONLY — manual SMS
            sends from a contact profile are unaffected. Disabling silences the
            bot; the persona + Twilio creds are preserved, so re-enabling
            resumes instantly.
          </GateToggle>

          <GateToggle
            checked={webChatEnabled}
            onChange={setWebChatEnabled}
            disabled={saving}
            icon={
              <Bot className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
            }
            title="Web Chat AI"
          >
            When enabled, this sub-account can embed the AI web-chat widget on
            its clients&apos; sites and the bot answers visitors. Each exchange
            spends your agency&apos;s shared OpenRouter credits. Disabling makes
            the widget go silent (it silently no-ops on the client&apos;s page);
            the channel config + session history are preserved, so re-enabling
            resumes instantly.
          </GateToggle>

          <GateToggle
            checked={inboundVoiceEnabled}
            onChange={setInboundVoiceEnabled}
            disabled={saving}
            icon={
              <PhoneIncoming className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            }
            title="Inbound Voice AI"
          >
            When enabled, this sub-account can turn on the Vapi-powered AI that
            answers inbound phone calls on its dedicated Twilio number. Spends
            both Vapi call minutes AND OpenRouter tokens, which is why it&apos;s
            controlled here (like outbound calling). Disabling stops the AI from
            answering; re-enable to resume. Outbound AI calling is gated
            separately above.
          </GateToggle>

          <GateToggle
            checked={metaInboxEnabled}
            onChange={setMetaInboxEnabled}
            disabled={saving || (metaUnconfigured && !initialMetaInbox)}
            icon={
              <MessagesSquare className="h-3.5 w-3.5 text-pink-600 dark:text-pink-400" />
            }
            title="Facebook + Instagram inbox"
            beta
          >
            When enabled, this sub-account can connect a Facebook Page +
            Instagram business account so Messenger and IG DMs land in the
            unified inbox alongside SMS/WhatsApp. <strong>Beta</strong> — both
            channels ride one Meta connection and stay completely hidden until
            you switch this on; off is the default for every sub-account.
            Disabling silences and hides the channels; nothing is torn down, so
            re-enabling resumes instantly. Leave off for any client that
            doesn&apos;t actively use Facebook/Instagram messaging.
            {metaUnconfigured && (
              <span className="mt-1 block font-medium text-amber-600 dark:text-amber-400">
                Unavailable — set <code>META_APP_ID</code> and{" "}
                <code>META_APP_SECRET</code> on the deployment to enable.
              </span>
            )}
          </GateToggle>

          <GateToggle
            checked={metaAgentEnabled}
            onChange={setMetaAgentEnabled}
            disabled={saving || (metaUnconfigured && !initialMetaAgent)}
            icon={
              <MessagesSquare className="h-3.5 w-3.5 text-pink-600 dark:text-pink-400" />
            }
            title="Messenger & Instagram AI auto-reply"
            beta
          >
            When enabled, this sub-account can turn on the AI agent for its
            Messenger and Instagram DMs — the same persona that answers SMS and
            Web Chat replies to inbound DMs automatically. Each reply spends
            your agency&apos;s shared OpenRouter credits. Requires the Facebook
            + Instagram inbox (above) to be enabled and a connected Meta Page.
            Disabling silences the bot; manual replies from the inbox are
            unaffected.
            {metaUnconfigured && (
              <span className="mt-1 block font-medium text-amber-600 dark:text-amber-400">
                Unavailable — set <code>META_APP_ID</code> and{" "}
                <code>META_APP_SECRET</code> on the deployment to enable.
              </span>
            )}
          </GateToggle>

          <GateToggle
            checked={socialPlannerEnabled}
            onChange={setSocialPlannerEnabled}
            disabled={saving || (metaUnconfigured && !initialSocial)}
            icon={
              <Share2 className="h-3.5 w-3.5 text-fuchsia-600 dark:text-fuchsia-400" />
            }
            title="Social Planner"
            beta
            hideOption={{
              hidden: socialHidden,
              onHiddenChange: setSocialHidden,
              disabled: saving,
            }}
          >
            When enabled, this sub-account can connect a Facebook Page +
            Instagram business account and schedule posts that auto-publish at
            the chosen time. <strong>Beta</strong> — posting reuses the same
            Meta connection as the inbox plus extra publish permissions
            (requires Meta App Review). Disabling locks the Social Planner
            sidebar entry and 403s the connect/publish routes; scheduled posts
            and the connection are preserved, so re-enabling resumes instantly.
            {metaUnconfigured && (
              <span className="mt-1 block font-medium text-amber-600 dark:text-amber-400">
                Unavailable — set <code>META_APP_ID</code> and{" "}
                <code>META_APP_SECRET</code> on the deployment to enable.
              </span>
            )}
          </GateToggle>

          <GateToggle
            checked={communityEnabled}
            onChange={setCommunityEnabled}
            disabled={saving}
            icon={
              <GraduationCap className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />
            }
            title="Community + Courses"
            hideOption={{
              hidden: communityHidden,
              onHiddenChange: setCommunityHidden,
              disabled: saving,
            }}
          >
            When enabled, this sub-account can run Skool-style community groups
            — a member feed, courses, and a leaderboard at a branded public link
            (<code>/c/…</code>). Members sign in with a magic link and become
            CRM contacts. Disabling locks the Community sidebar entry AND takes
            the public group pages offline; members, posts, and courses are
            preserved, so re-enabling resumes instantly.
          </GateToggle>

          <GateToggle
            checked={paymentsEnabled}
            onChange={setPaymentsEnabled}
            disabled={saving}
            icon={
              <CreditCard className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            }
            title="Payments (client's own Stripe)"
            hideOption={{
              hidden: paymentsHidden,
              onHiddenChange: setPaymentsHidden,
              disabled: saving,
            }}
          >
            When enabled, this sub-account can connect its OWN Stripe account
            (Settings → Payments) and take card payments from its customers.
            Money goes straight to the client&apos;s Stripe — it never touches
            your balance, and you take no cut. Separate from the plan you bill
            this client on your own Stripe. Disabling hides the card and 403s
            the connect route; the stored connection is preserved, so
            re-enabling resumes instantly.
          </GateToggle>

          <GateToggle
            checked={webinar1Enabled}
            onChange={setWebinar1Enabled}
            disabled={saving}
            icon={
              <MonitorPlay className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
            }
            title="Webinars (Webinar1 integration)"
            hideOption={{
              hidden: webinar1Hidden,
              onHiddenChange: setWebinar1Hidden,
              disabled: saving,
            }}
          >
            When enabled, this sub-account can connect its own Webinar1
            deployment (Settings → Admin), create evergreen webinars from the
            Webinars page, push contacts into them, and get registrations +
            attendance synced back onto contact timelines. Disabling locks the
            sidebar entry and 403s the routes; the stored connection is
            preserved, so re-enabling resumes instantly.
          </GateToggle>

          <GateToggle
            checked={googleEnabled}
            onChange={setGoogleEnabled}
            disabled={saving}
            icon={
              <MapPin className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
            }
            title="Google Business Profile"
          >
            When enabled, this sub-account can connect the Google account that
            manages its Business Profile (Settings → Google Business Profile).
            Disabling hides the card and refuses new connects; the stored
            connection is preserved, so re-enabling resumes instantly.
            Disconnecting stays available either way.
          </GateToggle>

          <GateToggle
            checked={googleCalendarEnabled}
            onChange={setGoogleCalendarEnabled}
            disabled={saving}
            icon={
              <CalendarSync className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
            }
            title="Google Calendar sync"
          >
            When enabled, each member of this sub-account can connect their own
            Google Calendar (Settings → Calendar sync). Bookings assigned to
            them are added to their primary Google calendar, and their Google
            busy time blocks those slots on booking pages. Disabling hides the
            card, refuses new connects and stops the sync; connections are
            preserved, so re-enabling resumes instantly. Disconnecting stays
            available either way.
          </GateToggle>

          <GateToggle
            checked={reviewsAiEnabled}
            onChange={setReviewsAiEnabled}
            disabled={saving}
            icon={
              <Star className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            }
            title="Reviews AI"
          >
            When enabled, synced Google reviews with text are labelled
            positive / neutral / negative by AI (star-only reviews are labelled
            from their stars, with no AI call). Each review is sent to the AI
            once — again only if it is edited; a failed analysis is retried at
            most 3 times. Spends your OpenRouter credits. Disabling stops new
            analysis; existing labels stay.
          </GateToggle>

          <GateToggle
            checked={missedCallEnabled}
            onChange={setMissedCallEnabled}
            disabled={saving}
            icon={
              <PhoneMissed className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" />
            }
            title="Missed Call Text Back"
            beta
          >
            When enabled, this sub-account can point its dedicated Twilio
            number&apos;s voice line at LeadStack: inbound calls forward to the
            business&apos;s phone and, if unanswered, the caller is
            automatically texted back. Requires a dedicated Twilio number and is
            mutually exclusive with the AI inbound Voice agent (which answers
            calls itself). Disabling stops the sub-account re-enabling it; the
            sub-account&apos;s own toggle restores the number&apos;s prior voice
            settings.
          </GateToggle>

          {/* Get Leads is PARKED — toggle hidden while the flag is on. */}
          {!GET_LEADS_PARKED && (
            <GateToggle
              checked={getLeadsEnabled}
              onChange={setGetLeadsEnabled}
              disabled={saving}
              icon={
                <Radar className="h-3.5 w-3.5 text-cyan-600 dark:text-cyan-400" />
              }
              title="Get Leads"
              beta
              hideOption={{
                hidden: getLeadsHidden,
                onHiddenChange: setGetLeadsHidden,
                disabled: saving,
              }}
            >
              When enabled, this sub-account can prospect local businesses —
              search Google Maps listings by business type + location, see them
              on a map with enriched contact details (phone, website, email),
              and import the good ones as contacts.{" "}
              <strong>Experimental</strong> — every search spends your
              agency&apos;s shared Outscraper credits (roughly $0.10–0.20 per
              search), which is why you control who gets it. Disabling blocks
              new searches; nothing is torn down.
            </GateToggle>
          )}

          <GateToggle
            checked={aiSuiteEnabled}
            onChange={setAiSuiteEnabled}
            disabled={saving}
            icon={
              <Sparkles className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
            }
            title="Workspace Assistant"
            beta
            hideOption={{
              hidden: aiSuiteHidden,
              onHiddenChange: setAiSuiteHidden,
              disabled: saving,
            }}
            enabledExtras={
              <label className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                <span className="text-foreground font-medium">AI model</span>
                <select
                  value={aiSuiteModel}
                  onChange={(e) =>
                    setAiSuiteModel(e.target.value as "opus" | "sonnet")
                  }
                  disabled={saving}
                  className="border-input bg-background [&_option]:bg-background [&_option]:text-foreground h-8 rounded-md border px-2 text-xs"
                  aria-label="Workspace Assistant model"
                >
                  <option value="opus">Opus — default (most reliable)</option>
                  <option value="sonnet">Sonnet — lower cost</option>
                </select>
                <span>
                  Opus is the most reliable at multi-step actions; Sonnet costs
                  roughly half per reply but can be less sure-footed on complex
                  requests.
                </span>
              </label>
            }
          >
            The Workspace Assistant — the sub-account&apos;s in-app assistant
            that answers &quot;how do I…&quot; questions about the app and can
            perform a few actions (create a contact, task, or workflow), each of
            which the operator confirms before it runs.{" "}
            <strong>Off by default.</strong> Each reply spends your
            agency&apos;s OpenRouter credits, which is why you control who gets
            it. While off, the sidebar entry shows Locked and the assistant
            403s; nothing is torn down, so enabling/disabling is instant.
          </GateToggle>

          <GateToggle
            checked={labsEnabled}
            onChange={setLabsEnabled}
            disabled={saving}
            icon={
              <FlaskConical className="h-3.5 w-3.5 text-lime-600 dark:text-lime-400" />
            }
            title="Labs"
            beta
            hideOption={{
              hidden: labsHidden,
              onHiddenChange: setLabsHidden,
              disabled: saving,
            }}
          >
            When enabled, this sub-account gets a <strong>Labs</strong> section
            in its sidebar — the home for pre-release, experimental features
            (first up: the Inbox Follow-up Watchdog agent). Experimental means
            exactly that: features may change or be withdrawn, so switch it on
            only for workspaces that opt in to trying new things. Individual
            Labs features keep their own safeguards on top. Disabling locks the
            section; nothing is torn down.
          </GateToggle>
        </div>

        {willTearDown && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              This will remove the live sending domain{" "}
              <code className="rounded bg-amber-500/10 px-1">
                {subAccount.resendConfig?.domainName}
              </code>{" "}
              from Resend and revert this sub-account to the shared sender.
              In-flight broadcasts and automations will fall back automatically.
            </span>
          </div>
        )}

        {/* Danger zone — permanently delete a clean (unused) sub-account. The
            server refuses (409) if it holds real data, so this is safe to offer
            even though the button is destructive. Type-to-confirm guards fat
            fingers; account numbers are never reused after a delete. */}
        <div className="border-destructive/30 bg-destructive/5 rounded-lg border p-3">
          <div className="text-destructive flex items-center gap-2 text-sm font-medium">
            <Trash2 className="h-3.5 w-3.5" />
            Delete sub-account
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            Permanently deletes <strong>{subAccount.name}</strong> and its
            settings, members, and templates. Only works if it&apos;s empty — if
            it has any contacts, deals, tasks, or other records, deletion is
            blocked. This can&apos;t be undone.
          </p>
          <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              disabled={deleting || saving}
              placeholder={`Type "${subAccount.name}" to confirm`}
              aria-label="Type the sub-account name to confirm deletion"
              className="h-8 text-sm sm:max-w-xs"
            />
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="h-8 shrink-0"
              disabled={
                deleting || saving || deleteConfirm.trim() !== subAccount.name
              }
              onClick={handleDelete}
            >
              {deleting ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  Deleting…
                </>
              ) : (
                "Delete permanently"
              )}
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={saving || deleting}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!dirty || saving || deleting}
          >
            {saving ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GateToggle({
  checked,
  onChange,
  disabled,
  icon,
  title,
  beta,
  children,
  hideOption,
  enabledExtras,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
  icon: React.ReactNode;
  title: string;
  /** When true, renders a fuchsia "Beta" pill after the title. */
  beta?: boolean;
  children: React.ReactNode;
  /**
   * Optional "hide instead of lock" secondary control. Only the three
   * sidebar-gated features pass this. The sub-checkbox is only shown while the
   * feature is OFF (`!checked`) — there's no Locked state to hide when it's on.
   * Its `disabled` is independent of the main toggle's: hiding the Locked row is
   * pure presentation, so it stays available even when the feature itself can't
   * be enabled (e.g. a Meta feature with no app creds on the deployment).
   */
  hideOption?: {
    hidden: boolean;
    onHiddenChange: (value: boolean) => void;
    disabled?: boolean;
  };
  /**
   * Optional per-feature settings rendered while the gate is ON (the
   * mirror-image of `hideOption`, which shows while it's off). First user:
   * the Workspace Assistant's model picker.
   */
  enabledExtras?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "bg-card rounded-lg border transition-colors",
        checked ? "border-primary/40 bg-primary/5" : "hover:bg-muted/40"
      )}
    >
      <label className="flex cursor-pointer items-start gap-3 p-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          className="mt-0.5 h-4 w-4 cursor-pointer"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            {icon}
            {title}
            {beta && (
              <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-fuchsia-600 uppercase dark:text-fuchsia-400">
                Beta
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-1 text-xs">{children}</p>
        </div>
      </label>
      {enabledExtras && checked && (
        <div className="border-t border-dashed px-3 py-2 pl-10">
          {enabledExtras}
        </div>
      )}
      {hideOption && !checked && (
        <label className="text-muted-foreground flex cursor-pointer items-start gap-2 border-t border-dashed px-3 py-2 pl-10 text-xs">
          <input
            type="checkbox"
            checked={hideOption.hidden}
            onChange={(e) => hideOption.onHiddenChange(e.target.checked)}
            disabled={hideOption.disabled}
            className="mt-0.5 h-3.5 w-3.5 cursor-pointer"
          />
          <span>
            <span className="text-foreground font-medium">
              Hide from the sub-account entirely
            </span>{" "}
            <span className="text-muted-foreground">(default)</span> — omit the
            sidebar entry so they never know the feature exists. Uncheck to show
            a greyed <span className="font-medium">Locked</span> item instead
            (an upsell hook).
          </span>
        </label>
      )}
    </div>
  );
}
