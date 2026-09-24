import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { GLOBAL_TERRITORY_ID } from "@/types";

/**
 * Re-tag a contact's territory and fan the change out to everything the
 * account owns — its deals, quotes, tasks, events, and the agent proposals
 * that target it (their read rule is scoped by the copied territoryId). Territory is an
 * attribute of the contact (the account); child records inherit it, so
 * moving the contact moves the whole account to whoever covers the new
 * territory.
 *
 * Admin-only (territory reassignment is an admin action). Body:
 *   { territoryId: string }   // empty / missing → Global (the floor)
 *
 * The fan-out runs in batched writes (Firestore's 500-op cap). For a
 * typical account (a handful of deals/quotes/tasks) this is one batch.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; contactId: string }> }
) {
  const { id: subAccountId, contactId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { territoryId?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  // Global is the floor — there's no "unassigned". A missing/empty value
  // sends the account back to the shared Global pool.
  const territoryId =
    typeof body.territoryId === "string" && body.territoryId.length > 0
      ? body.territoryId
      : GLOBAL_TERRITORY_ID;

  const db = getAdminDb();

  const contactRef = db.doc(`contacts/${contactId}`);
  const contactSnap = await contactRef.get();
  if (!contactSnap.exists) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  if (contactSnap.data()?.subAccountId !== subAccountId) {
    return NextResponse.json(
      { error: "Contact belongs to a different sub-account" },
      { status: 403 }
    );
  }
  const fromTerritoryId =
    (contactSnap.data()?.territoryId as string | null | undefined) ?? null;

  // Validate the target exists + is active. Global is the reserved floor —
  // always valid, so skip the lookup for it. Resolve a human-readable name
  // alongside for the timeline activity row below.
  let toTerritoryName = "Global";
  if (territoryId !== GLOBAL_TERRITORY_ID) {
    const tSnap = await db
      .doc(`subAccounts/${subAccountId}/territories/${territoryId}`)
      .get();
    if (!tSnap.exists || tSnap.data()?.status !== "active") {
      return NextResponse.json(
        { error: "Territory doesn't exist or is archived." },
        { status: 400 }
      );
    }
    toTerritoryName = (tSnap.data()?.name as string | undefined) ?? "Unnamed";
  }

  // Gather the account's child records across the collections that carry a
  // denormalised territoryId.
  const childCollections = ["deals", "quotes", "tasks", "events"] as const;
  const childSnaps = await Promise.all(
    childCollections.map((col) =>
      db
        .collection(col)
        .where("subAccountId", "==", subAccountId)
        .where("contactId", "==", contactId)
        .get()
    )
  );

  // Build the full ref list (contact + all children), then commit in
  // 500-op batches.
  const refs: FirebaseFirestore.DocumentReference[] = [];
  for (const snap of childSnaps) {
    for (const d of snap.docs) refs.push(d.ref);
  }

  const counts: Record<string, number> = {
    deals: childSnaps[0].size,
    quotes: childSnaps[1].size,
    tasks: childSnaps[2].size,
    events: childSnaps[3].size,
  };

  const stamp = FieldValue.serverTimestamp();
  // Read both contact and every linked conversation in the same transaction.
  // Concurrent message creation conflicts with this read and retries against the
  // new territory, so a private move never leaves a globally visible preview.
  const movedConversations = await db.runTransaction(async (tx) => {
    const current = (await tx.get(contactRef)).data();
    if (
      !current ||
      current.subAccountId !== subAccountId ||
      current.agencyId !== contactSnap.data()?.agencyId
    )
      throw new Error("Contact tenant changed during territory move.");
    const conversations = await tx.get(
      db
        .collection("conversations")
        .where("subAccountId", "==", subAccountId)
        .where("contactId", "==", contactId)
    );
    for (const conversation of conversations.docs) {
      if (conversation.data().agencyId !== current.agencyId)
        throw new Error("Conversation tenant mismatch during territory move.");
    }
    tx.update(contactRef, { territoryId, updatedAt: stamp });
    for (const conversation of conversations.docs)
      tx.update(conversation.ref, { territoryId, updatedAt: stamp });
    return conversations.docs.length;
  });
  counts.conversations = movedConversations;
  // Agent proposals are read AFTER the contact commit, so one proposed in
  // between (it read the old territory) is still caught. Only rows whose
  // target is this contact are re-synced; proposals targeting a deal or task
  // by its own territory are not re-synced in v1.
  const proposals = await db
    .collection("agentProposals")
    .where("subAccountId", "==", subAccountId)
    .where("contactId", "==", contactId)
    .get();
  for (const d of proposals.docs) refs.push(d.ref);
  counts.agentProposals = proposals.size;
  for (let i = 0; i < refs.length; i += 500) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + 500)) {
      batch.update(ref, { territoryId, updatedAt: stamp });
    }
    await batch.commit();
  }

  // Log the move on the contact's timeline so it surfaces alongside notes
  // and pipeline events. Best-effort — a stale activity write must never
  // 500 the cascade that already committed above. Only logged when the
  // territory actually changed (no-op PATCHes don't pollute the timeline).
  if (fromTerritoryId !== territoryId) {
    let fromTerritoryName = "Global";
    if (fromTerritoryId && fromTerritoryId !== GLOBAL_TERRITORY_ID) {
      const fromSnap = await db
        .doc(`subAccounts/${subAccountId}/territories/${fromTerritoryId}`)
        .get();
      fromTerritoryName =
        (fromSnap.data()?.name as string | undefined) ?? "Unnamed";
    }
    const childParts: string[] = [];
    if (counts.deals > 0)
      childParts.push(`${counts.deals} deal${counts.deals === 1 ? "" : "s"}`);
    if (counts.quotes > 0)
      childParts.push(
        `${counts.quotes} quote${counts.quotes === 1 ? "" : "s"}`
      );
    if (counts.tasks > 0)
      childParts.push(`${counts.tasks} task${counts.tasks === 1 ? "" : "s"}`);
    if (counts.events > 0)
      childParts.push(
        `${counts.events} event${counts.events === 1 ? "" : "s"}`
      );
    const childSuffix =
      childParts.length > 0 ? ` (${childParts.join(", ")})` : "";
    try {
      await contactRef.collection("activities").add({
        type: "contact_territory_changed",
        content: `Account moved from ${fromTerritoryName} to ${toTerritoryName}${childSuffix}.`,
        createdBy: access.uid,
        meta: {
          fromTerritoryId: fromTerritoryId ?? null,
          toTerritoryId: territoryId,
          movedDeals: counts.deals,
          movedQuotes: counts.quotes,
          movedTasks: counts.tasks,
          movedEvents: counts.events,
        },
        createdAt: stamp,
      });
    } catch (err) {
      console.warn("[territory-retag] activity write failed", err);
    }
  }

  return NextResponse.json({
    ok: true,
    contactId,
    territoryId,
    moved: counts,
  });
}
