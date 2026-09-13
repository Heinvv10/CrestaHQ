import "server-only";
import { createHash } from "node:crypto";
import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { writeInboundMessageActivity } from "@/lib/server/contact-activities";
import { validEmail } from "@/lib/comms/smtp";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { EmailMessageDoc } from "@/types/email";

export interface RecordEmailMessageInput {
  subAccountId: string;
  contactId?: string;
  direction: "inbound" | "outbound";
  subject: string;
  body: string;
  from: string;
  to: string[];
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  sentByUid?: string | null;
  attachments?: EmailMessageDoc["attachments"];
  occurredAt: Date;
  historical: boolean;
  mailboxFence?: { version: string; leaseToken: string };
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const millis = (value: unknown): number =>
  value instanceof Date
    ? value.getTime()
    : ((value as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0);

// Legacy contacts lack a normalized email field. Page their tenant-only index once per
// short-lived worker cache, then re-read selected contacts inside the write transaction.
const legacyIndexes = new Map<
  string,
  { until: number; index: Promise<Map<string, string>> }
>();
async function legacyContactIndex(
  subAccountId: string
): Promise<Map<string, string>> {
  const now = Date.now();
  const cached = legacyIndexes.get(subAccountId);
  if (cached && cached.until > now) return cached.index;
  for (const [key, value] of legacyIndexes)
    if (value.until <= now) legacyIndexes.delete(key);
  const index = (async () => {
    const result = new Map<string, string>();
    let after: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = getAdminDb()
        .collection("contacts")
        .where("subAccountId", "==", subAccountId)
        .orderBy(FieldPath.documentId())
        .limit(1000);
      if (after) query = query.startAfter(after);
      const page = await query.get();
      for (const doc of page.docs) {
        const email = String(doc.data().email ?? "")
          .trim()
          .toLowerCase();
        if (email && !result.has(email)) result.set(email, doc.id);
      }
      if (page.docs.length < 1000) break;
      after = page.docs[page.docs.length - 1];
    }
    return result;
  })();
  legacyIndexes.set(subAccountId, { until: now + 60000, index });
  try {
    return await index;
  } catch (error) {
    legacyIndexes.delete(subAccountId);
    throw error;
  }
}

/** One transaction commits all recipient messages and indexes. No workflow or reply side effects. */
export async function recordEmailMessage(
  input: RecordEmailMessageInput
): Promise<{ contactId: string; inserted: boolean }> {
  if (
    !input.subAccountId ||
    input.subAccountId.includes("/") ||
    input.contactId?.includes("/")
  )
    throw new Error("Invalid tenant or contact.");
  const from = input.from.trim().toLowerCase();
  const to = [...new Set(input.to.map((v) => v.trim().toLowerCase()))];
  if (
    !validEmail(from) ||
    !to.length ||
    to.length > 100 ||
    to.some((v) => !validEmail(v)) ||
    !Number.isFinite(input.occurredAt.getTime())
  )
    throw new Error("Invalid email message.");
  const correspondents = input.direction === "inbound" ? [from] : to;
  const messageId =
    input.messageId.trim() ||
    `fallback-${hash(JSON.stringify([from, to, input.subject, input.body, input.occurredAt.toISOString()]))}`;
  const db = getAdminDb();
  // This discovery is deliberately outside the transaction: large tenants can have
  // many thousands of legacy rows. The transaction still verifies every identity.
  const legacy =
    input.contactId && correspondents.length === 1
      ? null
      : await legacyContactIndex(input.subAccountId);
  let tenantAgencyId = "";
  const result = await db.runTransaction(async (tx) => {
    const sub = await tx.get(db.doc(`subAccounts/${input.subAccountId}`));
    const agencyId = sub.data()?.agencyId as string | undefined;
    tenantAgencyId = agencyId ?? "";
    if (!sub.exists || !agencyId)
      throw new Error("Email tenant does not exist.");
    if (input.mailboxFence) {
      const mailbox = (
        await tx.get(
          db.doc(`subAccounts/${input.subAccountId}/private/mailboxConnection`)
        )
      ).data();
      if (
        !mailbox ||
        mailbox.version !== input.mailboxFence.version ||
        mailbox.leaseToken !== input.mailboxFence.leaseToken ||
        !(Number(mailbox.leaseUntil) > Date.now())
      )
        throw new Error("Mailbox changed or sync lease expired.");
    }
    let explicitEmail: string | undefined;
    if (input.contactId) {
      const explicit = (
        await tx.get(db.doc(`contacts/${input.contactId}`))
      ).data();
      if (
        !explicit ||
        explicit.subAccountId !== input.subAccountId ||
        explicit.agencyId !== agencyId
      )
        throw new Error("Explicit contact tenant mismatch.");
      explicitEmail = String(explicit.email ?? "")
        .trim()
        .toLowerCase();
      if (!correspondents.includes(explicitEmail))
        throw new Error("Contact email does not match correspondent.");
    }
    const indexRef = db.doc(
      `subAccounts/${input.subAccountId}/emailMessageIndex/${hash(messageId)}`
    );
    const index = (await tx.get(indexRef)).data();
    if (
      index &&
      (index.subAccountId !== input.subAccountId || index.agencyId !== agencyId)
    )
      throw new Error("Message index tenant mismatch.");
    const contactByEmail: Record<string, string> = {
      ...(index?.contactByEmail ?? {}),
    };
    // A reply names the message it answers. When that message is on file, its
    // index says which contact holds this correspondent's thread — the tie-break
    // when several contacts share one address. Grouping stays by address: a
    // parent's contact is only used for the SAME address, never to pull mail from
    // another sender into someone else's conversation.
    const parentId = input.inReplyTo || input.references?.at(-1);
    const parent =
      parentId && parentId !== messageId
        ? (
            await tx.get(
              db.doc(
                `subAccounts/${input.subAccountId}/emailMessageIndex/${hash(parentId)}`
              )
            )
          ).data()
        : undefined;
    const threadContactByEmail: Record<string, string> =
      parent?.subAccountId === input.subAccountId && parent.agencyId === agencyId
        ? (parent.contactByEmail ?? {})
        : {};
    const pending: {
      ref: FirebaseFirestore.DocumentReference;
      data: Record<string, unknown>;
      merge?: boolean;
    }[] = [];
    let firstContactId = "";
    let inserted = false;
    for (const email of correspondents) {
      const explicitId = email === explicitEmail ? input.contactId : undefined;
      const indexedId = contactByEmail[email];
      if (indexedId && explicitId && indexedId !== explicitId)
        throw new Error("Message already belongs to another contact.");
      let matchId: string | undefined = indexedId;
      const threadId = threadContactByEmail[email];
      if (!explicitId && !matchId && threadId) {
        const threadContact = (
          await tx.get(db.doc(`contacts/${threadId}`))
        ).data();
        if (
          threadContact?.subAccountId === input.subAccountId &&
          threadContact.agencyId === agencyId &&
          String(threadContact.email ?? "")
            .trim()
            .toLowerCase() === email
        )
          matchId = threadId;
      }
      if (!explicitId && !matchId) {
        const matches = await tx.get(
          db
            .collection("contacts")
            .where("subAccountId", "==", input.subAccountId)
            .where("email", "==", email)
            .limit(1)
        );
        matchId = matches.docs[0]?.id;
        if (!matchId) matchId = legacy?.get(email);
      }
      const contactId =
        explicitId ||
        matchId ||
        `email_${hash(`${input.subAccountId}\0${email}`).slice(0, 40)}`;
      const contactRef = db.doc(`contacts/${contactId}`);
      // Always read the deterministic fallback: concurrent imports conflict and retry rather than create duplicate contacts.
      const contactSnap = await tx.get(contactRef);
      const contact = contactSnap.data();
      if (explicitId && !contactSnap.exists)
        throw new Error("Explicit contact does not exist.");
      if (
        contact &&
        (contact.subAccountId !== input.subAccountId ||
          contact.agencyId !== agencyId)
      )
        throw new Error("Contact tenant mismatch.");
      if (
        contact &&
        String(contact.email ?? "")
          .trim()
          .toLowerCase() !== email
      ) {
        throw new Error("Contact email does not match correspondent.");
      }
      if (!firstContactId) firstContactId = contactId;
      contactByEmail[email] = contactId;
      const messageRef = db.doc(
        `contacts/${contactId}/emailMessages/${hash(messageId)}`
      );
      const conversationRef = db.doc(`conversations/${contactId}`);
      const messageSnap = await tx.get(messageRef);
      const conversationSnap = await tx.get(conversationRef);
      const old = conversationSnap.data();
      if (
        old &&
        (old.subAccountId !== input.subAccountId || old.agencyId !== agencyId)
      )
        throw new Error("Conversation tenant mismatch.");
      if (messageSnap.exists) {
        const existing = messageSnap.data();
        if (
          existing?.subAccountId !== input.subAccountId ||
          existing?.agencyId !== agencyId
        )
          throw new Error("Message tenant mismatch.");
        continue;
      }
      inserted = true;
      const occurredAt = Timestamp.fromDate(input.occurredAt);
      if (!contactSnap.exists)
        pending.push({
          ref: contactRef,
          data: {
            name: email,
            email,
            phone: "",
            company: "",
            address: "",
            source: "other",
            mode: "live",
            territoryId: GLOBAL_TERRITORY_ID,
            tags: [],
            pipelineStage: null,
            attribution: null,
            agencyId,
            subAccountId: input.subAccountId,
            createdByUid: input.sentByUid ?? "system:mailbox",
            emailOptedOut: false,
            smsOptedOut: false,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
        });
      pending.push({
        ref: messageRef,
        data: {
          id: messageRef.id,
          agencyId,
          subAccountId: input.subAccountId,
          contactId,
          direction: input.direction,
          subject: input.subject,
          body: input.body,
          from,
          to,
          messageId,
          inReplyTo: input.inReplyTo ?? null,
          references: input.references ?? [],
          status: input.direction === "inbound" ? "received" : "sent",
          createdAt: occurredAt,
          sentByUid: input.sentByUid ?? null,
          attachments: input.attachments ?? [],
        },
      });
      const patch: Record<string, unknown> = {
        contactId,
        agencyId,
        subAccountId: input.subAccountId,
        territoryId: contactSnap.exists
          ? (contact?.territoryId ?? null)
          : GLOBAL_TERRITORY_ID,
        contactName: contact?.name || email,
        contactPhone: contact?.phone || null,
        channelsSeen: FieldValue.arrayUnion("email"),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!old)
        Object.assign(patch, {
          createdAt: occurredAt,
          status: "open",
          assigneeUid: null,
          botMode: "off",
          botPausedUntil: null,
          pendingDraft: null,
          unreadCount: 0,
        });
      if (!old || millis(old.lastMessageAt) <= input.occurredAt.getTime())
        Object.assign(patch, {
          lastChannel: "email",
          lastDirection: input.direction,
          lastMessagePreview: input.body.slice(0, 120),
          lastMessageAt: occurredAt,
        });
      if (!input.historical && input.direction === "inbound")
        patch.unreadCount = Number(old?.unreadCount ?? 0) + 1;
      pending.push({ ref: conversationRef, data: patch, merge: true });
    }
    if (!firstContactId)
      throw new Error("Contact email does not match any recipient.");
    if (inserted)
      pending.push({
        ref: indexRef,
        data: { agencyId, subAccountId: input.subAccountId, contactByEmail },
      });
    for (const write of pending)
      tx.set(write.ref, write.data, { merge: write.merge ?? false });
    return { contactId: firstContactId, inserted };
  });
  // Timeline row for a NEW live inbound mail — written after the
  // transaction commits, never inside it (a derived row must not be able to
  // abort the message write). Historical backfill stays off the timeline.
  if (result.inserted && input.direction === "inbound" && !input.historical) {
    await writeInboundMessageActivity(db, {
      contactId: result.contactId,
      channel: "email",
      preview: input.subject ? `${input.subject} — ${input.body}` : input.body,
      messageId,
      agencyId: tenantAgencyId,
      subAccountId: input.subAccountId,
    });
  }
  return result;
}
