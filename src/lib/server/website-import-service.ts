import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import { claimSiteSlot, siteSlotFree } from "@/lib/server/websites-service";
import { TEMPLATE_ID_RE } from "@/lib/website/templates";
import { blankWebsiteConfig, type WebsiteConfig, type WebsiteDoc } from "@/types/website";
import {
  fetchClientSites,
  gitpageIsConfigured,
  hideClientSite,
  renameClientSites,
  type GitpageClientSite,
} from "@/lib/gitpage/client";

/**
 * Sites the client made in gitpage.
 *
 * On a site LeadStack built for a sub-account, the client's gitpage editors
 * can Duplicate it (gitpage "client editors"). The copy belongs to the
 * agency's gitpage account, tagged with the same sub-account, so it shows up
 * here: `syncClientSitesFromGitpage` imports copies LeadStack doesn't know yet
 * as ready website docs (within the per-sub-account cap). Deleting a website
 * hides it in gitpage (`hideWebsiteInGitpage`) and leaves a tombstone
 * (`writeWebsiteTombstones`), so a deleted site never comes back.
 *
 * The sync also sends the sub-account's current name, for gitpage's Client
 * filter in My Sites.
 *
 * Imported docs have the deterministic id `gp-<pageId>`. Every pageId and
 * URL here has already been checked by the gitpage client
 * (`fetchClientSites`): a pageId is a gitpage ObjectId, a live URL is a
 * public https address.
 *
 * Deviation from upstream: each import is ONE transaction that counts the
 * cap (on the same limits doc every site creation writes), checks the
 * tombstone and the existing docs, and creates — upstream checked first and
 * created after, so two syncs at once (or a sync beside a create) could pass
 * the cap, and a delete landing in between could be re-imported.
 */

const dismissedPath = (subAccountId: string, pageId: string) =>
  `subAccounts/${subAccountId}/websiteDismissed/${pageId}`;

/** Gave up after its retries because other writers kept winning (gRPC ABORTED). */
const isContention = (err: unknown) => (err as { code?: unknown } | null)?.code === 10;

export async function syncClientSitesFromGitpage(subAccountId: string): Promise<{ imported: number }> {
  if (!isDocId(subAccountId) || !gitpageIsConfigured()) return { imported: 0 };
  const db = getAdminDb();
  const sub = await db.doc(`subAccounts/${subAccountId}`).get();
  const subData = sub.exists ? (sub.data() as Record<string, unknown>) : null;
  if (!subData || subData.websiteEnabledByAgency !== true || typeof subData.agencyId !== "string") {
    return { imported: 0 };
  }
  const agencyId = subData.agencyId;

  // Keep the client's name current in gitpage (its My Sites Client filter),
  // alongside the site list.
  const name = typeof subData.name === "string" ? subData.name.trim() : "";
  const [, sites] = await Promise.all([
    name
      ? renameClientSites(subAccountId, name).catch((err) =>
          console.warn(
            `[website/sync] could not send the client name to gitpage sa=${subAccountId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
      : null,
    fetchClientSites(subAccountId),
  ]);
  const copies = sites.filter((s) => s.origin === "duplicate" && s.status === "Published" && s.liveUrl);

  let imported = 0;
  for (const site of copies) {
    let outcome: "imported" | "skipped" | "cap";
    try {
      outcome = await importCopy(subAccountId, agencyId, site);
    } catch (err) {
      // Many writers on the sub-account at once: the next sync tries again.
      if (isContention(err)) break;
      throw err;
    }
    if (outcome === "cap") break;
    if (outcome === "imported") imported++;
  }
  return { imported };
}

/** One copy, all-or-nothing: the cap, the tombstone and the duplicate check are read in the transaction that creates. */
async function importCopy(
  subAccountId: string,
  agencyId: string,
  site: GitpageClientSite,
): Promise<"imported" | "skipped" | "cap"> {
  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}/website/gp-${site.pageId}`);
  return db.runTransaction(async (tx) => {
    const slot = await siteSlotFree(tx, subAccountId);
    const [dismissed, own] = [await tx.get(db.doc(dismissedPath(subAccountId, site.pageId))), await tx.get(ref)];
    // Only this sub-account's own docs: the copy's config is never taken
    // from another workspace's site.
    const docs = slot.docs.filter((d) => d.subAccountId === subAccountId);
    const known = docs.some((d) => d.gitpagePageId === site.pageId || d.replacesGitpagePageId === site.pageId);
    if (dismissed.exists || own.exists || known) return "skipped";
    if (!slot.free) return "cap";

    const source = site.duplicatedFrom ? docs.find((d) => d.gitpagePageId === site.duplicatedFrom) : undefined;
    const sourceName = source?.name || source?.config?.heading || null;
    const config: WebsiteConfig = source?.config ? { ...blankWebsiteConfig(), ...source.config } : blankWebsiteConfig();
    const now = FieldValue.serverTimestamp();
    tx.create(ref, {
      id: ref.id,
      agencyId,
      subAccountId,
      name: sourceName ? `${sourceName} (copy)`.slice(0, 80) : site.repoName || "Website copy",
      status: "ready",
      gitpageJobId: null,
      liveUrl: site.liveUrl,
      errorMessage: null,
      partialErrors: null,
      pollAttempts: 0,
      lastBuildAt: null,
      lastBuildByUid: null,
      config,
      quality: site.quality,
      gitpagePageId: site.pageId,
      customDomain: site.customDomain,
      importedFrom: "gitpage",
      statusPhase: "completed",
      createdAt: now,
      updatedAt: now,
    });
    claimSiteSlot(tx, subAccountId);
    return "imported";
  });
}

/**
 * The gitpage sites a website doc stands for: its current one, the one a
 * build in progress replaces, and the copy it was imported from. Only
 * gitpage ObjectIds — each becomes a doc id under `websiteDismissed`.
 */
export function pageIdsOf(doc: Pick<WebsiteDoc, "id" | "gitpagePageId" | "replacesGitpagePageId">): string[] {
  const ids = [doc.gitpagePageId, doc.replacesGitpagePageId, doc.id?.startsWith("gp-") ? doc.id.slice(3) : null];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && TEMPLATE_ID_RE.test(id)))];
}

/**
 * A website is being deleted in LeadStack: remember its gitpage sites so a
 * sync never imports them again. Written in the delete's own transaction
 * (deviation from upstream, which wrote them before the delete and swallowed
 * failures): the doc goes and the tombstones stay, or neither happens.
 */
export function writeWebsiteTombstones(
  tx: FirebaseFirestore.Transaction,
  subAccountId: string,
  doc: Pick<WebsiteDoc, "id" | "gitpagePageId" | "replacesGitpagePageId">,
): void {
  const db = getAdminDb();
  for (const pageId of pageIdsOf(doc)) {
    tx.set(db.doc(dismissedPath(subAccountId, pageId)), { pageId, dismissedAt: FieldValue.serverTimestamp() });
  }
}

/**
 * A website was deleted in LeadStack: hide its gitpage sites — the current
 * one and, for an imported copy that was rebuilt since, the copy (they stay
 * live; the agency can unhide them in gitpage). Never throws — deleting in
 * LeadStack always succeeds.
 */
export async function hideWebsiteInGitpage(
  subAccountId: string,
  doc: Pick<WebsiteDoc, "id" | "gitpagePageId" | "replacesGitpagePageId">,
): Promise<void> {
  if (!gitpageIsConfigured()) return;
  for (const pageId of pageIdsOf(doc)) {
    try {
      await hideClientSite(pageId, subAccountId);
    } catch (err) {
      console.error(
        `[website/delete] could not hide the site in gitpage sa=${subAccountId} page=${pageId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
