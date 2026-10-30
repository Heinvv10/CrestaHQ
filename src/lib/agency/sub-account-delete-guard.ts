/**
 * What stops `deleteSubAccountForAgency` (the delete has no cascade), and the
 * agent approval rows that go with a sub-account once it may be deleted.
 * Plain module, no server imports (it is handed the Firestore), so
 * `scripts/teardown-smoke-sub-account.ts` refuses exactly what the app does.
 */

type Db = FirebaseFirestore.Firestore;

/**
 * Top-level collections keyed by `subAccountId` whose presence means the
 * sub-account has been genuinely used. Seeded/auto-created data (the owner
 * membership, welcome `message_templates`, counters, the `userMemberships`
 * index) is deliberately excluded — a freshly-created test sub-account still
 * counts as "clean". Each entry maps a collection to the human label shown to
 * the agency owner when a delete is blocked.
 */
const USAGE_COLLECTIONS: ReadonlyArray<{ collection: string; label: string }> =
  [
    { collection: "contacts", label: "contacts" },
    { collection: "deals", label: "deals" },
    { collection: "tasks", label: "tasks" },
    { collection: "events", label: "calendar events" },
    { collection: "forms", label: "forms" },
    { collection: "quotes", label: "quotes / invoices" },
    { collection: "products", label: "products" },
    { collection: "automations", label: "automations" },
    { collection: "workflows", label: "workflows" },
    { collection: "broadcasts", label: "broadcasts" },
    { collection: "socialPosts", label: "social posts" },
    { collection: "voiceCampaigns", label: "voice campaigns" },
    { collection: "companies", label: "companies" },
    { collection: "snippets", label: "saved replies" },
    { collection: "trackedLinks", label: "tracked links" },
    { collection: "paymentLinks", label: "payment links" },
    { collection: "prospectLists", label: "prospect lists" },
    { collection: "prospectReports", label: "prospect reports" },
    { collection: "recurringInvoices", label: "recurring invoices" },
  ];

/**
 * Events other than imported Google ones (`source: "google"`): those are a
 * copy of members' own calendars, not CRM data, and the delete removes them
 * itself. Two counts, not a `!=` query: that would skip legacy events with
 * no `source` at all.
 */
async function hasOwnEvents(db: Db, subAccountId: string): Promise<boolean> {
  const all = db.collection("events").where("subAccountId", "==", subAccountId);
  const [total, imported] = await Promise.all([
    all.count().get(),
    all.where("source", "==", "google").count().get(),
  ]);
  return total.data().count > imported.data().count;
}

/** Rows a person still has to act on: undecided, mid-action, or outcome unknown. */
const OPEN_PROPOSAL_STATUSES = ["pending", "executing", "unsettled"] as const;
export const DECIDED_PROPOSAL_STATUSES: ReadonlySet<string> = new Set(["executed", "failed", "rejected", "expired"]);

/** A sub-account's agent rows: its own, and agency-level rows aimed at it (`subAccountId: null`). */
export const PROPOSAL_KEYS = ["subAccountId", "targetSubAccountId"] as const;

/**
 * Labels of what still blocks deleting this sub-account; empty when it may go.
 * `except` names usage collections the caller deletes itself (the teardown
 * script); the app passes none.
 */
export async function findDeleteBlockers(
  db: Db,
  subAccountId: string,
  except: ReadonlySet<string> = new Set()
): Promise<string[]> {
  const usage = USAGE_COLLECTIONS.filter(({ collection }) => !except.has(collection)).map(async ({ collection, label }) => {
    if (collection === "events") return (await hasOwnEvents(db, subAccountId)) ? label : null;
    const snap = await db.collection(collection).where("subAccountId", "==", subAccountId).limit(1).get();
    return snap.empty ? null : label;
  });
  // Equality-only probes, so no composite index is needed.
  const open = PROPOSAL_KEYS.flatMap((key) =>
    OPEN_PROPOSAL_STATUSES.map(async (status) => {
      const snap = await db
        .collection("agentProposals")
        .where(key, "==", subAccountId)
        .where("status", "==", status)
        .limit(1)
        .get();
      return !snap.empty;
    })
  );
  const [labels, anyOpen] = await Promise.all([Promise.all(usage), Promise.all(open)]);
  const blockers = labels.filter((l): l is string => l !== null);
  if (anyOpen.some(Boolean)) blockers.push("agent approvals waiting or in progress");
  return blockers;
}

/**
 * Deletes the sub-account's decided agent rows (history) with their `history/`
 * generations. Each row is re-read in its own transaction and skipped unless
 * it is still decided: a row id is reused when an agent re-proposes the same
 * action, so a row found decided by the query may be pending again by now.
 * Returns how many such rows turned open again; the caller then refuses.
 */
export async function deleteDecidedProposals(db: Db, subAccountId: string): Promise<number> {
  const snaps = await Promise.all(
    PROPOSAL_KEYS.map((key) => db.collection("agentProposals").where(key, "==", subAccountId).get())
  );
  const decided = snaps.flatMap((s) => s.docs).filter((d) => DECIDED_PROPOSAL_STATUSES.has(d.data().status as string));
  const refs = [...new Map(decided.map((d) => [d.ref.path, d.ref])).values()];
  let reopened = 0;
  for (const ref of refs) {
    const deleted = await db.runTransaction(async (tx) => {
      const row = await tx.get(ref);
      const history = await tx.get(ref.collection("history"));
      if (!row.exists) return true;
      if (!DECIDED_PROPOSAL_STATUSES.has(row.data()?.status as string)) return false;
      for (const h of history.docs) tx.delete(h.ref);
      tx.delete(ref);
      return true;
    });
    if (!deleted) reopened++;
  }
  return reopened;
}
