import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  getAgentProfile,
  getChannelConfig,
  upsertAgentProfile,
  upsertChannelConfig,
} from "@/lib/comms/ai/agent";
import { aiChannelGateOn } from "@/lib/comms/ai/gates";
import { aiIsConfigured } from "@/lib/comms/ai/openrouter";
import { emailIsConfigured } from "@/lib/comms/resend";
import {
  smsIsConfigured,
  subAccountTwilioIsConfigured,
} from "@/lib/comms/twilio";
import { sendPushForEvent } from "@/lib/push/send";
import { isDocId } from "@/lib/server/doc-id";
import {
  createWorkflowServerSide,
  deleteWorkflowServerSide,
  workflowPatchWrite,
} from "@/lib/server/workflows-service";
import { publicFetch } from "@/lib/webhooks/public-fetch";
import {
  DEFAULT_WEB_CHAT_CONFIG,
  type AiAgentProfile,
  type AiChannelConfig,
} from "@/types/ai";
import type { AgencyDoc, SubAccountDoc } from "@/types/tenancy";
import type { WorkflowDoc, WorkflowNode } from "@/types/workflows";
import {
  wantsChatWidget,
  wantsLeadForm,
  type WebsiteConfig,
  type WebsiteDoc,
  type WebsiteProvisioning,
} from "@/types/website";
import { cleanText, safePagesUrl, type PollBuildResult } from "@/lib/gitpage/client";

/**
 * Website Build v2 hand-off: when a PREMIUM gitpage build publishes, do as
 * much of the follow-on setup as possible so the site is ready to work the
 * moment it is live — the sub-account's chat widget may load on it, its
 * contact form feeds the CRM, and a speed-to-lead workflow is waiting for a
 * person to switch on.
 *
 * Runs only while the agency's `websiteEnabledByAgency` gate is on: settling
 * a build keeps the site doc truthful, the hand-off is new work in the
 * workspace. Gate off → null, nothing written.
 *
 * Every step is best-effort and independent: a failure is recorded in
 * `provisioning.errors` and never un-publishes the site. The whole routine
 * is idempotent (safe to run on a rebuild or a duplicate callback):
 *   1. Chat allowlist — append the live hostname to `webChat.allowedDomains`,
 *      and take the persona's welcome message + the site's accent colour
 *      where the operator has not set their own. The channel's `enabled`
 *      flag is never touched (see below).
 *   2. KB + persona — seed `aiAgent/profile` with gitpage's kbText (replaces
 *      the Firecrawl snapshot; `websiteKbSource: "gitpage-build"`) and fill
 *      persona fields ONLY where blank. ONE profile write.
 *   3. Speed-to-lead — provision ONE workflow pinned to the site's form from
 *      the `speed-to-lead` seed, dropping channel steps the deployment
 *      can't send (SMS/email readiness). Always a DRAFT.
 *   4. Push — tell the team the site is live (fails silently without VAPID).
 *
 * DIFFERENCES FROM UPSTREAM (68798611), all deliberate:
 *   - Nothing here starts talking to leads. Upstream publishes the workflow
 *     when a customer-facing step survives and QStash is set, and switches
 *     the web-chat bot on when OpenRouter and the agency gate allow. Here
 *     the workflow stays a draft and the bot stays as the operator left it;
 *     a person activates each. `provisioning` says what is waiting.
 *   - Every value gitpage supplies is treated as outside data: the accent
 *     must be a #RRGGBB hex, text is control-character-stripped and capped,
 *     hostnames come only from a URL that passes `safePagesUrl`.
 *   - "One form, one workflow" is enforced by a claim in a transaction
 *     (`claimOnce`), not by a query followed by a create.
 *   - No Web Voice step (unit WV-5).
 */

const KB_MAX_CHARS = 6000;
/** The caps the AI Agents routes apply to an operator's own input. */
const PROMPT_MAX_CHARS = 8000;
const BUSINESS_NAME_MAX_CHARS = 200;
const WELCOME_MAX_CHARS = 400;
const MAX_ESCALATION_KEYWORDS = 25;
const KEYWORD_MAX_CHARS = 100;
const MAX_ALLOWED_DOMAINS = 25;
const WEBSITE_FORM_NAME = "Website contact";

/** Marker fields stamped on the provisioned workflow for idempotency. */
export const WEBSITE_WORKFLOW_SOURCE = "website-build";

/**
 * `subAccounts/{id}/private/websiteHandoff` — Admin SDK only, under the
 * generic `private/{docId}` deny rule. `contactFormId` and `workflowId`: the
 * ONE "Website contact" form and the ONE speed-to-lead workflow the hand-off
 * made for this sub-account. Two builds for one workspace can reach the
 * "is there one yet?" query at the same moment and both see none; what each
 * creates is then claimed here in a transaction, and the one that loses
 * deletes its own and uses the winner's.
 */
export const websiteHandoffStatePath = (subAccountId: string) =>
  `subAccounts/${subAccountId}/private/websiteHandoff`;

/**
 * Record `candidate` as the sub-account's one resource of this kind, unless
 * another caller already has. `stale` is the id this caller read from the
 * marker and found dead (deleted since); only that value may be replaced.
 * Returns the id that holds the claim.
 */
async function claimOnce(
  subAccountId: string,
  field: "contactFormId" | "workflowId",
  candidate: string,
  stale: string | null,
): Promise<string> {
  const db = getAdminDb();
  const ref = db.doc(websiteHandoffStatePath(subAccountId));
  return db.runTransaction(async (tx) => {
    const held = (await tx.get(ref)).data()?.[field] as unknown;
    if (typeof held === "string" && held && held !== stale) return held;
    tx.set(ref, { [field]: candidate, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return candidate;
  });
}

async function readClaim(
  subAccountId: string,
  field: "contactFormId" | "workflowId",
): Promise<string | null> {
  const held = (await getAdminDb().doc(websiteHandoffStatePath(subAccountId)).get()).data()?.[field] as unknown;
  return isDocId(held) ? held : null;
}

export interface HandoffInput {
  subAccountId: string;
  siteId: string;
  site: WebsiteDoc;
  config: WebsiteConfig;
  liveUrl: string;
  result: PollBuildResult;
}

/**
 * The hostname to allow-list for a site address, or null. Only from a URL
 * that passes `safePagesUrl` (https, no credentials, not localhost or a
 * non-public IP literal), and only a plain DNS name: the allowlist is
 * compared against the Origin header of whoever loads the widget.
 */
function safeHostnameOf(url: string | null | undefined): string | null {
  const safe = safePagesUrl(url);
  if (!safe) return null;
  const host = new URL(safe).hostname.toLowerCase().replace(/\.$/, "");
  return /^[a-z0-9.-]+$/.test(host) && host.includes(".") ? host : null;
}

/**
 * Multi-line text from gitpage (the knowledge base, the persona prompt):
 * control characters other than newline and tab are removed, the ends are
 * trimmed and the result is cut to `max`. Null when nothing is left.
 */
function cleanBlock(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, "").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

/**
 * gitpage's accent as a stored colour, or null: #RRGGBB only, lower-cased —
 * the widget puts this value in a style attribute. Same test as the AI
 * Agents channel route applies to an operator's own pick.
 */
function hexColor(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Find or create the sub-account's "Website contact" form. One per
 * sub-account (reused across sites and rebuilds) so submissions land in a
 * single place and the speed-to-lead workflow has one anchor.
 */
export async function ensureWebsiteContactForm(input: {
  subAccountId: string;
  createdByUid: string;
  /** A form id already on the site doc — reused if it still exists. */
  existingFormId?: string | null;
}): Promise<string> {
  const db = getAdminDb();
  const owned = async (formId: string): Promise<boolean> => {
    if (!isDocId(formId)) return false;
    const snap = await db.doc(`forms/${formId}`).get();
    return snap.exists && snap.data()?.subAccountId === input.subAccountId;
  };
  if (input.existingFormId && (await owned(input.existingFormId))) {
    return input.existingFormId;
  }
  const claimed = await readClaim(input.subAccountId, "contactFormId");
  if (claimed && (await owned(claimed))) return claimed;

  const existing = await db
    .collection("forms")
    .where("subAccountId", "==", input.subAccountId)
    .where("name", "==", WEBSITE_FORM_NAME)
    .limit(1)
    .get();
  let candidate = existing.empty ? null : existing.docs[0].id;
  const created = candidate === null;
  if (candidate === null) {
    // Lazy import keeps the forms service out of the client-side graph.
    const { createFormServerSide } = await import("@/lib/server/forms-service");
    candidate = await createFormServerSide({
      subAccountId: input.subAccountId,
      createdByUid: input.createdByUid,
      name: WEBSITE_FORM_NAME,
      template: "contact",
    });
  }
  const formId = await claimOnce(input.subAccountId, "contactFormId", candidate, claimed);
  // Another build claimed its form first: one form per sub-account.
  if (created && formId !== candidate) await db.doc(`forms/${candidate}`).delete();
  return formId;
}

/** Hosts that are never a published site — git hosts' own pages and the
 *  GitLab Pages access-control login (projects.gitlab.io/auth). */
const NON_SITE_HOSTS = new Set([
  "gitlab.com",
  "www.gitlab.com",
  "projects.gitlab.io",
  "github.com",
  "www.github.com",
]);

/** False for a URL that is clearly a login/auth page rather than the site. */
export function isPlausibleSiteUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (NON_SITE_HOSTS.has(u.hostname.toLowerCase())) return false;
    return !/^\/users\/sign_in\b/.test(u.pathname);
  } catch {
    return false;
  }
}

/** Requests the walk below may make for one URL (so at most four redirects). */
const MAX_REDIRECT_HOPS = 5;
const RESOLVE_TIMEOUT_MS = 3000;
/** A redirect answer is headers; nothing here needs a body. */
const PROBE_MAX_BYTES = 64 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The live address to store for a just-published site: the reported Pages
 * URL with redirects resolved (path URL → unique domain), but ONLY when the
 * redirect lands on a real site. gitpage reports GitLab's path URL
 * (user.gitlab.io/repo), which 308s to the project's unique domain — the
 * hostname visitors actually load, and so the one the chat allowlist must
 * contain. GitLab Pages access control can also briefly redirect a fresh
 * project to its login (→ gitlab.com/users/sign_in); that once became a
 * site's "live URL", Visit link and chat allowlist host upstream
 * (2026-10-04). On a non-site landing, keep the reported URL.
 *
 * The URL is gitpage's, not ours, so nothing here follows a redirect on its
 * own (upstream uses `fetch` with `redirect: "follow"`). Each hop is one
 * `publicFetch` — which in production connects only to public addresses and
 * never follows a redirect — and each `Location` is resolved against the hop
 * it came from and must itself be a plain public https site address before
 * it is requested. HEAD, not upstream's GET: only the status and `Location`
 * are read, and a landing page larger than the body cap would otherwise
 * count as a failure.
 *
 * Never throws. ONE 3 s deadline covers every hop. Returns the input on the
 * hop cap, a redirect with no `Location`, a hop that is refused, or any
 * error.
 */
export async function resolveLiveUrl(pagesUrl: string): Promise<string> {
  if (!isPlausibleSiteUrl(pagesUrl)) {
    console.warn(`[website] gitpage reported a non-site live URL: ${pagesUrl}`);
    return pagesUrl;
  }
  try {
    const signal = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
    let current = pagesUrl;
    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
      const res = await publicFetch(current, { method: "HEAD", signal, maxBytes: PROBE_MAX_BYTES });
      if (!REDIRECT_STATUSES.has(res.status)) return current;
      const location = res.headers.get("location");
      if (!location) return pagesUrl;
      const next = safePagesUrl(new URL(location, current).href);
      if (!next || !isPlausibleSiteUrl(next)) return pagesUrl;
      current = next;
    }
    return pagesUrl;
  } catch {
    return pagesUrl;
  }
}

/** The LeadStack endpoints baked into a premium site. Null when the app URL isn't public https. */
export function leadstackWiringFor(input: {
  subAccountId: string;
  formId: string | null;
  config: WebsiteConfig;
  /** Pass the result of `resolvedAppUrl()` so no baked URL ever redirects. */
  appUrl?: string | null;
}): {
  appUrl: string;
  subAccountId: string;
  formId?: string;
  formSubmitUrl?: string;
  widgetScriptUrl?: string;
} | null {
  const appUrl = (input.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (!/^https:\/\/[^\s/]+$/i.test(appUrl)) return null;
  return {
    appUrl,
    subAccountId: input.subAccountId,
    ...(wantsLeadForm(input.config) && input.formId
      ? { formId: input.formId, formSubmitUrl: `${appUrl}/api/forms/${input.formId}/submit` }
      : {}),
    ...(wantsChatWidget(input.config) ? { widgetScriptUrl: `${appUrl}/widget.js` } : {}),
  };
}

/** The absolute `build.settled` callback URL, or null when not publicly reachable. */
export function buildSettledCallbackUrl(resolved?: string | null): string | null {
  const appUrl = (resolved ?? process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (!/^https:\/\/[^\s/]+$/i.test(appUrl)) return null;
  return `${appUrl}/api/webhooks/gitpage/build-settled`;
}

/** A hand-off summary with nothing done yet — also what a hand-off that threw records. */
export function blankProvisioning(formId: string | null, errors: string[] = []): WebsiteProvisioning {
  return {
    at: FieldValue.serverTimestamp(),
    hostname: null,
    formId,
    chatAllowlisted: false,
    chatEnabled: false,
    chatSkippedReason: null,
    kbSeeded: false,
    personaSeeded: false,
    workflowId: null,
    workflowStatus: null,
    workflowChannels: [],
    errors,
  };
}

// ---------------------------------------------------------------------------
// The hand-off

/** Null when the agency's website gate is off for the workspace: nothing ran. */
export async function provisionWebsiteHandoff(
  input: HandoffInput,
): Promise<WebsiteProvisioning | null> {
  const { subAccountId, siteId, site, config, liveUrl, result } = input;
  const db = getAdminDb();

  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const sub = (subSnap.data() ?? {}) as SubAccountDoc;
  // The gate as it is NOW, not as it was when the build was accepted. Fails
  // closed: a missing sub-account or a missing field is "off".
  if (sub.websiteEnabledByAgency !== true) return null;
  const agencyId = (sub.agencyId as string | undefined) ?? site.agencyId;

  const errors: string[] = [];
  // liveUrl is already redirect-resolved by settleWebsiteBuild; also keep
  // gitpage's reported host so both entry points load the widget. Both are
  // re-checked here, where they are used.
  const safeLiveUrl = safePagesUrl(liveUrl);
  const hostname = safeHostnameOf(liveUrl);
  const reportedHost = safeHostnameOf(result.pagesUrl);
  const premium = result.premium;
  if (!hostname) errors.push("live URL: not a public https address — its host was not added to the chat allowlist");

  const out = blankProvisioning(site.formId ?? null, errors);
  out.hostname = hostname;

  // Auto-filled values follow the LATEST published site until the operator
  // edits them. A value counts as "auto" when it's blank / the stock default,
  // or still equals what the hand-off seeded last time. Profiles seeded
  // before this tracking existed (KB from a build, no record) are treated as
  // auto too. The operator's own wording is never overwritten.
  const profileBefore = await getAgentProfile(subAccountId).catch(() => null);
  const seededBefore = profileBefore?.websiteSeeded ?? null;
  const legacyAuto = !seededBefore && profileBefore?.websiteKbSource === "gitpage-build";
  const isAuto = (current: string | null | undefined, seeded: string | null | undefined, stock?: string) =>
    !current?.trim() || (stock !== undefined && current === stock) || (!!seeded && current === seeded) || legacyAuto;
  const seededNext: NonNullable<AiAgentProfile["websiteSeeded"]> = { ...(seededBefore ?? {}) };

  // 1. Chat: allowlist the hostname. The bot is NOT switched on here.
  if (wantsChatWidget(config)) {
    try {
      const existing = await getChannelConfig(subAccountId, "web-chat");
      const current = { ...DEFAULT_WEB_CHAT_CONFIG, ...(existing?.webChat ?? {}) };
      const have = new Set(current.allowedDomains.map((d) => d.toLowerCase()));
      const add = [...new Set([hostname, reportedHost])].filter(
        (h): h is string => !!h && !have.has(h),
      );
      // A channel doc that does not exist yet gets the stock widget block;
      // an existing one is merged into, field by field.
      const webChat: Record<string, unknown> = existing?.webChat ? {} : { ...DEFAULT_WEB_CHAT_CONFIG };
      const full = add.length > 0 && have.size + add.length > MAX_ALLOWED_DOMAINS;
      if (full) {
        errors.push(`web-chat: the allowed-domains list is full (${MAX_ALLOWED_DOMAINS}) — add ${add.join(", ")} by hand`);
      } else if (add.length) {
        // arrayUnion, not read-then-write: a second site publishing for this
        // workspace at the same moment must not drop this one's host.
        webChat.allowedDomains = FieldValue.arrayUnion(...add);
      }
      const welcome = cleanText(premium?.agentPersona?.welcomeMessage, WELCOME_MAX_CHARS);
      if (welcome && isAuto(current.welcomeMessage, seededBefore?.welcomeMessage, DEFAULT_WEB_CHAT_CONFIG.welcomeMessage)) {
        webChat.welcomeMessage = welcome;
        seededNext.welcomeMessage = welcome;
      }
      const accent = hexColor(premium?.theme?.primaryColor);
      if (accent && isAuto(current.accentColor, seededBefore?.accentColor, DEFAULT_WEB_CHAT_CONFIG.accentColor)) {
        webChat.accentColor = accent;
        seededNext.accentColor = accent;
      }
      if (Object.keys(webChat).length > 0) {
        await upsertChannelConfig(subAccountId, "web-chat", {
          webChat,
        } as unknown as Partial<AiChannelConfig>);
      }
      out.chatAllowlisted = !!hostname && (have.has(hostname) || (!full && add.includes(hostname)));

      // Upstream switches the channel on here. Nothing automated starts
      // talking to visitors: the bot stays as the operator left it, and the
      // card says why it is off.
      out.chatEnabled = existing?.enabled === true;
      if (!out.chatEnabled) {
        out.chatSkippedReason = !aiIsConfigured()
          ? "OPENROUTER_API_KEY is not set on this deployment — the widget is on the site but the bot stays off until a key is added and Web Chat is enabled."
          : !aiChannelGateOn(sub, "web-chat")
            ? "The agency has locked Web Chat AI for this workspace."
            : "Web Chat AI is switched off for this workspace — the widget is on the site; turn the bot on in AI Agents when you are ready.";
      }
    } catch (err) {
      errors.push(`web-chat: ${errText(err)}`);
    }
  } else {
    out.chatSkippedReason = "Chat widget not included in this build.";
  }

  // 2. KB + persona (one write).
  try {
    const profile = profileBefore;
    const persona = premium?.agentPersona ?? null;
    const patch: Partial<AiAgentProfile> = {};
    if (safeLiveUrl) patch.websiteUrl = safeLiveUrl;
    const kb = cleanBlock(premium?.kbText, KB_MAX_CHARS);
    if (kb) {
      patch.websiteKb = kb;
      patch.websiteKbFetchedAt = FieldValue.serverTimestamp();
      patch.websiteKbSource = "gitpage-build";
      patch.websiteKbSiteId = siteId;
      out.kbSeeded = true;
    }
    if (persona) {
      const systemPrompt = cleanBlock(persona.systemPrompt, PROMPT_MAX_CHARS);
      if (systemPrompt && isAuto(profile?.systemPrompt, seededBefore?.systemPrompt)) {
        patch.systemPrompt = systemPrompt;
        seededNext.systemPrompt = systemPrompt;
        out.personaSeeded = true;
      }
      const businessName = cleanText(persona.businessName, BUSINESS_NAME_MAX_CHARS);
      if (businessName && isAuto(profile?.businessName, seededBefore?.businessName)) {
        patch.businessName = businessName;
        seededNext.businessName = businessName;
      }
      const keywords = (Array.isArray(persona.escalationKeywords) ? persona.escalationKeywords : [])
        .map((k) => cleanText(k, KEYWORD_MAX_CHARS))
        .filter((k): k is string => k !== null)
        .slice(0, MAX_ESCALATION_KEYWORDS);
      if (!profile && keywords.length) patch.escalationKeywords = keywords;
    }
    if (!profile?.escalationNotifyEmail?.trim()) {
      const email = (config.contact_details ?? "").trim() || sub.accountContact?.email?.trim() || "";
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) patch.escalationNotifyEmail = email;
    }
    patch.websiteSeeded = seededNext;
    await upsertAgentProfile(subAccountId, patch);
  } catch (err) {
    out.kbSeeded = false;
    out.personaSeeded = false;
    errors.push(`agent profile: ${errText(err)}`);
  }

  // 3. Speed-to-lead workflow pinned to the site's form. A DRAFT, always.
  if (wantsLeadForm(config) && site.formId) {
    try {
      const formId = site.formId;
      const ours = (wf: WorkflowDoc | undefined): wf is WorkflowDoc =>
        !!wf && wf.subAccountId === subAccountId && wf.trigger?.formId === formId;
      const report = (id: string, wf: WorkflowDoc) => {
        out.workflowId = id;
        out.workflowStatus = wf.status === "active" ? "active" : "draft";
        out.workflowChannels = Object.values(wf.nodes ?? {}).map((n) => n.type);
      };

      const claimed = await readClaim(subAccountId, "workflowId");
      const claimedWf = claimed
        ? ((await db.doc(`workflows/${claimed}`).get()).data() as WorkflowDoc | undefined)
        : undefined;
      if (claimed && ours(claimedWf)) {
        report(claimed, claimedWf);
      } else {
        const already = await db
          .collection("workflows")
          .where("subAccountId", "==", subAccountId)
          .where("provisionedFrom", "==", WEBSITE_WORKFLOW_SOURCE)
          .get();
        const match = already.docs.find(
          (d) => (d.data() as WorkflowDoc).trigger?.formId === formId,
        );
        let candidate = match?.id ?? null;
        const created = candidate === null;
        if (candidate === null) {
          const agencySnap = agencyId ? await db.doc(`agencies/${agencyId}`).get() : null;
          const agency = (agencySnap?.data() ?? {}) as AgencyDoc;
          const sharedSmsAllowed = agency.sharedSmsAllowed !== false;
          const smsReady =
            subAccountTwilioIsConfigured(sub.twilioConfig) ||
            (sharedSmsAllowed && smsIsConfigured());
          // The sub-account doc decides: its own SMTP, else the Resend env.
          const emailReady = emailIsConfigured(sub);

          // Created as a draft, and left one: `status` is never written.
          candidate = await createWorkflowServerSide({
            subAccountId,
            createdByUid: site.lastBuildByUid ?? "system",
            name: "Website speed-to-lead",
            template: "speed-to-lead",
            formId,
          });
          const seeded = (await db.doc(`workflows/${candidate}`).get()).data() as WorkflowDoc;
          const kept: WorkflowNode[] = [];
          for (const id of ["n1", "n2", "n3"]) {
            const node = seeded.nodes[id];
            if (!node) continue;
            if (node.type === "send_sms" && !smsReady) continue;
            if (node.type === "send_email" && !emailReady) continue;
            kept.push({ ...node });
          }
          // Re-link the surviving chain in order.
          const nodes: Record<string, WorkflowNode> = {};
          kept.forEach((node, i) => {
            nodes[node.id] = { ...node, next: kept[i + 1]?.id ?? null };
          });
          const notify = nodes.n3;
          if (notify) {
            notify.config = {
              ...notify.config,
              recipient: sub.accountContact?.email?.trim() ? "account_contact" : "owner",
              subject: `New lead from ${config.heading || "your website"}`,
              body: "{{contact.name}} ({{contact.email}} · {{contact.phone}}) just submitted the website contact form.",
            };
          }
          await db.doc(`workflows/${candidate}`).update({
            ...workflowPatchWrite({ nodes, startNodeId: kept[0]?.id ?? null }),
            provisionedFrom: WEBSITE_WORKFLOW_SOURCE,
            provisionedSiteId: siteId,
          });
        }
        const workflowId = await claimOnce(subAccountId, "workflowId", candidate, claimed);
        // Another site's hand-off claimed its workflow first: one per workspace.
        if (created && workflowId !== candidate) {
          await deleteWorkflowServerSide(subAccountId, candidate);
        }
        const wf = (await db.doc(`workflows/${workflowId}`).get()).data() as WorkflowDoc | undefined;
        if (!wf || wf.subAccountId !== subAccountId) {
          throw new Error("the provisioned workflow could not be read back");
        }
        report(workflowId, wf);
      }
    } catch (err) {
      errors.push(`speed-to-lead: ${errText(err)}`);
    }
  }

  // 4. Push the team.
  if (agencyId) {
    try {
      await sendPushForEvent({
        subAccountId,
        agencyId,
        title: "Website published",
        body: `${site.name || config.heading || "Your site"} is live at ${hostname ?? liveUrl}.`,
        url: `/sa/${subAccountId}/website`,
        tag: `website-${siteId}`,
      });
    } catch (err) {
      errors.push(`push: ${errText(err)}`);
    }
  }

  return out;
}
