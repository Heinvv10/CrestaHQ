import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  getAgentProfile,
  getChannelConfig,
  upsertAgentProfile,
  upsertChannelConfig,
} from "@/lib/comms/ai/agent";
import { isDocId } from "@/lib/server/doc-id";
import {
  requireWebsiteEnabledSub,
  transitionWebsite,
  WebsiteServiceError,
} from "@/lib/server/websites-service";
import { DEFAULT_WEB_CHAT_CONFIG } from "@/types/ai";
import type { WebsiteDoc, WebsiteStatus } from "@/types/website";

export const dynamic = "force-dynamic";

/**
 * PUT  { domain }  — record the custom domain a live site is served on
 *                    (e.g. "www.peakyoga.com"), allow-list it (and its
 *                    www/apex twin) for the Web Chat widget, and point the
 *                    chat bot's website URL at it when the bot was seeded
 *                    from this site.
 * DELETE           — clear it (removes the domain(s) this route added).
 *
 * The domain itself is configured in GitLab/GitHub by the operator; this
 * only keeps LeadStack's side (chat allow-list, KB source, card URL) in sync.
 *
 * What may become a Web Chat origin, and for whom:
 *  - only the sub-account in the path, which must own the site (the site doc
 *    is read under that sub-account and must carry its id) — a domain is
 *    never written into another tenant's allow-list;
 *  - only exact hostnames: the domain, plus its www/apex twin. No wildcard,
 *    no IP, no port, no gitlab.io/github.io host, and never this app's own
 *    host or a host under it (Labs funnel subdomains are other tenants'
 *    pages). The web-chat origin check is an exact hostname match.
 *
 * PUT is gated on `websiteEnabledByAgency` like the draft save. DELETE is
 * not, like removing a site: a gated-off workspace can always take a domain
 * back off its allow-list.
 */

const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Same cap as the Web Chat settings form (`allowedDomains`, 25 entries). */
const MAX_ALLOWED_DOMAINS = 25;

const ALL_STATUSES: readonly WebsiteStatus[] = ["draft", "queued", "building", "ready", "failed"];

const siteNotFound = () => NextResponse.json({ error: "Website not found." }, { status: 404 });

/** This deployment's own host with any leading www., or null when unknown. */
function appRootHost(): string | null {
  try {
    const host = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "").hostname.toLowerCase();
    return host ? host.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

type DomainCheck = { domain: string } | { error: string };

function normaliseDomain(raw: unknown): DomainCheck {
  const invalid = { error: "Enter a domain like www.yourbusiness.com (not a gitlab.io or github.io address)." };
  if (typeof raw !== "string") return invalid;
  let d = raw.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  if (!HOST_RE.test(d)) return invalid;
  if (/\.(gitlab|github)\.io$/.test(d)) return invalid;
  // Unknown app host = cannot tell a platform host from a customer's: refuse.
  const root = appRootHost();
  if (!root) return { error: "This deployment's app URL is not configured, so a custom domain can't be checked." };
  if (d === root || d.endsWith(`.${root}`)) {
    return { error: "That address belongs to this app, not to your website." };
  }
  return { domain: d };
}

/** The domain plus its www/apex twin — visitors may arrive on either. */
function variants(domain: string): string[] {
  if (domain.startsWith("www.")) return [domain, domain.slice(4)];
  return domain.split(".").length === 2 ? [domain, `www.${domain}`] : [domain];
}

async function loadSite(subAccountId: string, siteId: string) {
  const ref = getAdminDb().doc(`subAccounts/${subAccountId}/website/${siteId}`);
  const snap = await ref.get();
  const site = snap.data() as WebsiteDoc | undefined;
  if (!snap.exists || !site || site.subAccountId !== subAccountId) return null;
  return { ref, site };
}

/** The sub-account's web-chat allow-list with `remove` taken out and `add` put in. */
async function nextAllowList(subAccountId: string, add: string[], remove: string[]) {
  const existing = await getChannelConfig(subAccountId, "web-chat");
  const webChat = { ...DEFAULT_WEB_CHAT_CONFIG, ...(existing?.webChat ?? {}) };
  const set = new Set(webChat.allowedDomains.map((d) => d.toLowerCase()));
  for (const d of remove) set.delete(d);
  for (const d of add) set.add(d);
  return { webChat, allowedDomains: [...set] };
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  if (!isDocId(siteId)) return siteNotFound();
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  try {
    await requireWebsiteEnabledSub(subAccountId);
  } catch (err) {
    if (err instanceof WebsiteServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  let body: { domain?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const checked = normaliseDomain(body?.domain);
  if ("error" in checked) return NextResponse.json({ error: checked.error }, { status: 400 });
  const { domain } = checked;

  const found = await loadSite(subAccountId, siteId);
  if (!found) return siteNotFound();
  const { ref, site } = found;
  if (site.status !== "ready") {
    return NextResponse.json({ error: "Add a custom domain once the site is live." }, { status: 409 });
  }

  const previous = site.customDomain ?? null;
  const removed = previous && previous !== domain ? variants(previous) : [];
  const chat = await nextAllowList(subAccountId, variants(domain), removed);
  if (chat.allowedDomains.length > MAX_ALLOWED_DOMAINS) {
    return NextResponse.json(
      {
        error: `The chat widget's allowed domains list is full (${MAX_ALLOWED_DOMAINS}). Remove one in the Web Chat settings, then save the domain again.`,
      },
      { status: 409 },
    );
  }

  // Recorded only on the live build that was read, and only if nobody
  // changed the domain in between.
  const saved = await transitionWebsite(
    ref,
    {
      expectJobId: site.gitpageJobId ?? null,
      fromStatuses: ["ready"],
      when: (fresh) => (fresh.customDomain ?? null) === previous,
    },
    { customDomain: domain, updatedAt: FieldValue.serverTimestamp() },
  );
  if (!saved.applied) {
    if (saved.reason === "missing") return siteNotFound();
    return NextResponse.json(
      { error: "This site changed while the domain was being saved. Reload and try again." },
      { status: 409 },
    );
  }

  const warnings: string[] = [];
  try {
    await upsertChannelConfig(subAccountId, "web-chat", {
      webChat: { ...chat.webChat, allowedDomains: chat.allowedDomains },
    });
  } catch (err) {
    console.error(`[website/domain] chat allow-list update failed sa=${subAccountId} site=${siteId}`, reason(err));
    warnings.push("The chat widget's allowed domains were not updated — add the domain in the Web Chat settings.");
  }

  // Point the chat bot's source URL at the custom domain when it was seeded
  // from this site (or currently points at this site's gitlab/github URL).
  try {
    const profile = await getAgentProfile(subAccountId);
    // `websiteKbSiteId` is written by the publish hand-off (WS-3); read
    // narrowly so this compiles before that field is on the type.
    const seededFrom = (profile as { websiteKbSiteId?: unknown } | null)?.websiteKbSiteId;
    const pointsHere =
      seededFrom === siteId ||
      (!!site.liveUrl && profile?.websiteUrl === site.liveUrl) ||
      (!!previous && profile?.websiteUrl === `https://${previous}/`);
    if (pointsHere) await upsertAgentProfile(subAccountId, { websiteUrl: `https://${domain}/` });
  } catch (err) {
    console.error(`[website/domain] chat bot website update failed sa=${subAccountId} site=${siteId}`, reason(err));
    warnings.push("The chat bot's website address was not updated.");
  }

  return NextResponse.json({ ok: true, customDomain: domain, warnings });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  if (!isDocId(siteId)) return siteNotFound();
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const found = await loadSite(subAccountId, siteId);
  if (!found) return siteNotFound();
  const { ref, site } = found;
  const previous = site.customDomain ?? null;
  if (!previous) return NextResponse.json({ ok: true });

  // The allow-list first: if it cannot be updated the domain stays recorded,
  // so the operator can retry — never an allowed origin with no record of
  // why it is there.
  try {
    const chat = await nextAllowList(subAccountId, [], variants(previous));
    await upsertChannelConfig(subAccountId, "web-chat", {
      webChat: { ...chat.webChat, allowedDomains: chat.allowedDomains },
    });
  } catch (err) {
    console.error(`[website/domain] chat allow-list removal failed sa=${subAccountId} site=${siteId}`, reason(err));
    return NextResponse.json(
      { error: "Couldn't take the domain off the chat widget's allowed list. Try again." },
      { status: 502 },
    );
  }

  const warnings: string[] = [];
  try {
    const profile = await getAgentProfile(subAccountId);
    if (profile?.websiteUrl === `https://${previous}/` && site.liveUrl) {
      await upsertAgentProfile(subAccountId, { websiteUrl: site.liveUrl });
    }
  } catch (err) {
    console.error(`[website/domain] chat bot website reset failed sa=${subAccountId} site=${siteId}`, reason(err));
    warnings.push("The chat bot's website address was not changed back.");
  }

  const cleared = await transitionWebsite(
    ref,
    { fromStatuses: ALL_STATUSES, when: (fresh) => (fresh.customDomain ?? null) === previous },
    { customDomain: null, updatedAt: FieldValue.serverTimestamp() },
  );
  if (!cleared.applied) {
    if (cleared.reason === "missing") return siteNotFound();
    return NextResponse.json(
      { error: "This site's domain changed while it was being removed. Reload and try again." },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, warnings });
}
