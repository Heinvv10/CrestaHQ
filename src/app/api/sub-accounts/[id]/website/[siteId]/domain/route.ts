import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { agentProfileInTx, prepareAiAgentDocs, webChatAllowListInTx } from "@/lib/comms/ai/agent";
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
 * DELETE           — clear it (removes the host(s) this route added).
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
 *    public suffix, no localhost or *.localhost, no gitlab.io/github.io
 *    host, and never this app's own host or a host under it (Labs funnel
 *    subdomains are other tenants' pages). The web-chat origin check is an
 *    exact hostname match;
 *  - a host only one site holds: a domain whose hosts another site of this
 *    sub-account already holds is refused (409), so removing one site's
 *    domain can never take hosts off that another still relies on.
 *
 * The site doc, the allow-list and the chat bot's website address are
 * written in ONE transaction (through `transitionWebsite`), with the
 * 25-entry cap counted inside it: a domain is never allowed without being
 * recorded, nor recorded without being allowed, and the bot never names a
 * domain that is gone, whatever runs alongside (a DELETE, another site's
 * save, the Web Chat settings form). Removing the whole site takes its
 * recorded hosts off too (`../route.ts`). The site records the hosts the save actually added
 * (`customDomainChatHosts`, the pair minus any already listed); replacing
 * or removing the domain takes off those and nothing else, so hosts the
 * operator listed by hand stay.
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
  // Loopback names resolve to the visitor's own machine, never a website.
  if (d.endsWith(".localhost")) return invalid;
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

/** Every host a site's custom domain holds (what it recorded is a subset). */
function hostsHeldBy(site: WebsiteDoc): string[] {
  return site.customDomain ? variants(site.customDomain) : [];
}

async function loadSite(subAccountId: string, siteId: string) {
  const ref = getAdminDb().doc(`subAccounts/${subAccountId}/website/${siteId}`);
  const snap = await ref.get();
  const site = snap.data() as WebsiteDoc | undefined;
  if (!snap.exists || !site || site.subAccountId !== subAccountId) return null;
  return { ref, site };
}

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  if (!isDocId(subAccountId) || !isDocId(siteId)) return siteNotFound();
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

  await prepareAiAgentDocs(subAccountId);
  const hosts = variants(domain);
  // Why the transaction refused, for the answer.
  const seen: { refusal?: "in-use" | "full" } = {};
  const saved = await transitionWebsite(
    ref,
    {
      fromStatuses: ["ready"],
      inTransaction: async (tx, fresh) => {
        delete seen.refusal;
        const sites = await tx.get(getAdminDb().collection(`subAccounts/${subAccountId}/website`));
        const list = await webChatAllowListInTx(tx, subAccountId);
        const agent = await agentProfileInTx(tx, subAccountId);
        const held = sites.docs
          .filter((d) => d.id !== siteId)
          .flatMap((d) => hostsHeldBy(d.data() as WebsiteDoc));
        if (hosts.some((h) => held.includes(h))) {
          seen.refusal = "in-use";
          return false;
        }
        const previous = fresh.customDomain ?? null;
        const recorded = fresh.customDomainChatHosts ?? [];
        // A new domain takes off the hosts the old one added; a re-save keeps them.
        const removed = previous && previous !== domain ? recorded : [];
        const kept = previous === domain ? recorded : [];
        const next = new Set(list.hosts);
        for (const h of removed) next.delete(h);
        // What this save adds: the hosts not listed once the old domain's are off.
        const added = hosts.filter((h) => !next.has(h));
        for (const h of hosts) next.add(h);
        if (next.size > MAX_ALLOWED_DOMAINS) {
          seen.refusal = "full";
          return false;
        }
        list.save([...next]);
        // Point the chat bot's source URL at the domain when it was seeded
        // from this site (or points at this site's live URL or old domain) —
        // in the same transaction, so it never names a domain that is gone.
        const profile = agent.profile;
        // `websiteKbSiteId` is written by the publish hand-off (WS-3); read
        // narrowly so this compiles before that field is on the type.
        const seededFrom = (profile as { websiteKbSiteId?: unknown } | null)?.websiteKbSiteId;
        const pointsHere =
          seededFrom === siteId ||
          (!!fresh.liveUrl && profile?.websiteUrl === fresh.liveUrl) ||
          (!!previous && profile?.websiteUrl === `https://${previous}/`);
        if (profile && pointsHere) agent.save({ websiteUrl: `https://${domain}/` });
        return { customDomainChatHosts: [...new Set([...kept, ...added])] };
      },
    },
    { customDomain: domain, updatedAt: FieldValue.serverTimestamp() },
  );
  if (!saved.applied) {
    if (saved.reason === "missing") return siteNotFound();
    const error =
      seen.refusal === "in-use"
        ? "Another website in this workspace already uses that domain. Remove it there first."
        : seen.refusal === "full"
          ? `The chat widget's allowed domains list is full (${MAX_ALLOWED_DOMAINS}). Remove one in the Web Chat settings, then save the domain again.`
          : "This site is no longer live. Reload and try again.";
    return NextResponse.json({ error }, { status: 409 });
  }

  return NextResponse.json({ ok: true, customDomain: domain });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  if (!isDocId(subAccountId) || !isDocId(siteId)) return siteNotFound();
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const found = await loadSite(subAccountId, siteId);
  if (!found) return siteNotFound();
  const { ref, site } = found;
  if (!site.customDomain) return NextResponse.json({ ok: true });

  await prepareAiAgentDocs(subAccountId);
  // The record, the hosts it added and the chat bot's address change
  // together, or not at all.
  const cleared = await transitionWebsite(
    ref,
    {
      fromStatuses: ALL_STATUSES,
      inTransaction: async (tx, fresh) => {
        const list = await webChatAllowListInTx(tx, subAccountId);
        const agent = await agentProfileInTx(tx, subAccountId);
        const recorded = new Set(fresh.customDomainChatHosts ?? []);
        const left = list.hosts.filter((h) => !recorded.has(h));
        if (left.length !== list.hosts.length) list.save(left);
        const previous = fresh.customDomain;
        if (previous && fresh.liveUrl && agent.profile?.websiteUrl === `https://${previous}/`) {
          agent.save({ websiteUrl: fresh.liveUrl });
        }
        return {};
      },
    },
    { customDomain: null, customDomainChatHosts: null, updatedAt: FieldValue.serverTimestamp() },
  );
  if (!cleared.applied) return siteNotFound();
  return NextResponse.json({ ok: true });
}
