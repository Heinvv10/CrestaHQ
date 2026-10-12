import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  editWebChatAllowedDomains,
  getAgentProfile,
  getChannelConfig,
  upsertAgentProfile,
} from "@/lib/comms/ai/agent";
import { registrableDomain } from "@/lib/prospecting/registrable-domain";
import { isDocId } from "@/lib/server/doc-id";
import {
  requireWebsiteEnabledSub,
  transitionWebsite,
  WebsiteServiceError,
} from "@/lib/server/websites-service";
import type { WebsiteDoc, WebsiteStatus } from "@/types/website";

export const dynamic = "force-dynamic";

/**
 * PUT  { domain }  — record the custom domain a live site is served on
 *                    (e.g. "www.peakyoga.com"), allow-list it (and its
 *                    www/apex twin) for the Web Chat widget, and point the
 *                    chat bot's website URL at it when the bot was seeded
 *                    from this site.
 * DELETE           — clear it (removes the host(s) this route added,
 *                    recorded on the site as `customDomainChatHosts`).
 *
 * The domain itself is configured in GitLab/GitHub by the operator; this
 * only keeps LeadStack's side (chat allow-list, KB source, card URL) in sync.
 *
 * What may become a Web Chat origin, and for whom:
 *  - only the sub-account in the path, which must own the site (the site doc
 *    is read under that sub-account and must carry its id) — a domain is
 *    never written into another tenant's allow-list;
 *  - only exact hostnames: the domain, plus its www/apex twin (the apex is
 *    the registrable domain from the Public Suffix List, so `acme.co.za`
 *    pairs with `www.acme.co.za`). No wildcard, no IP, no port, no bare
 *    public suffix, no gitlab.io/github.io host, and never this app's own
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
  // A bare public suffix ("co.za", "github.io") is nobody's site.
  if (!registrableDomain(d)) return invalid;
  // Unknown app host = cannot tell a platform host from a customer's: refuse.
  const root = appRootHost();
  if (!root) return { error: "This deployment's app URL is not configured, so a custom domain can't be checked." };
  if (d === root || d.endsWith(`.${root}`)) {
    return { error: "That address belongs to this app, not to your website." };
  }
  return { domain: d };
}

/**
 * The domain plus its www/apex twin — visitors may arrive on either. Only an
 * apex or `www.` + apex has a twin; any other subdomain is just itself.
 */
function variants(domain: string): string[] {
  const apex = registrableDomain(domain);
  if (domain === apex) return [domain, `www.${domain}`];
  if (apex && domain === `www.${apex}`) return [domain, apex];
  return [domain];
}

async function loadSite(subAccountId: string, siteId: string) {
  const ref = getAdminDb().doc(`subAccounts/${subAccountId}/website/${siteId}`);
  const snap = await ref.get();
  const site = snap.data() as WebsiteDoc | undefined;
  if (!snap.exists || !site || site.subAccountId !== subAccountId) return null;
  return { ref, site };
}

/** The sub-account's web-chat allow-list as it stands. */
async function listedHosts(subAccountId: string): Promise<string[]> {
  const existing = await getChannelConfig(subAccountId, "web-chat");
  return (existing?.webChat?.allowedDomains ?? []).map((d) => d.toLowerCase());
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
  const recorded = site.customDomainChatHosts ?? [];
  // A new domain takes off the hosts the old one added; a re-save keeps them.
  const removed = previous && previous !== domain ? recorded : [];
  const kept = previous === domain ? recorded : [];
  const hosts = variants(domain);
  const after = new Set(await listedHosts(subAccountId));
  for (const h of removed) after.delete(h);
  // What this save adds: the hosts not listed once the old domain's are off.
  const added = hosts.filter((h) => !after.has(h));
  for (const h of hosts) after.add(h);
  // A fast refusal with nothing written; the allow-list write re-checks the
  // cap in its own transaction.
  if (after.size > MAX_ALLOWED_DOMAINS) {
    return NextResponse.json(
      {
        error: `The chat widget's allowed domains list is full (${MAX_ALLOWED_DOMAINS}). Remove one in the Web Chat settings, then save the domain again.`,
      },
      { status: 409 },
    );
  }

  // Recorded only on the live build that was read, and only if nobody
  // changed the domain in between — and BEFORE the allow-list is widened,
  // so no host is ever allowed without a record of why it is there.
  const saved = await transitionWebsite(
    ref,
    {
      expectJobId: site.gitpageJobId ?? null,
      fromStatuses: ["ready"],
      when: (fresh) => (fresh.customDomain ?? null) === previous,
    },
    {
      customDomain: domain,
      customDomainChatHosts: [...new Set([...kept, ...added])],
      updatedAt: FieldValue.serverTimestamp(),
    },
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
    const listed = await editWebChatAllowedDomains(subAccountId, {
      add: hosts,
      remove: removed,
      max: MAX_ALLOWED_DOMAINS,
    });
    if (listed === "full") {
      warnings.push(
        `The chat widget's allowed domains list filled up (${MAX_ALLOWED_DOMAINS}) before the domain could be added — remove one in the Web Chat settings, then remove and save the domain again.`,
      );
    }
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
  // Only the hosts the save added: any the operator listed by hand stay.
  try {
    const recorded = site.customDomainChatHosts ?? [];
    if (recorded.length) await editWebChatAllowedDomains(subAccountId, { add: [], remove: recorded });
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
    { customDomain: null, customDomainChatHosts: null, updatedAt: FieldValue.serverTimestamp() },
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
