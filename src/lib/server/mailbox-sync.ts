import "server-only";
import { randomUUID } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  connectMailbox,
  mailSignalsFromRaw,
  parseMailboxMessage,
  MAX_MESSAGE_BYTES,
  MailboxError,
  mailboxPublicError,
} from "@/lib/comms/imap";
import { recordEmailMessage } from "@/lib/server/email-conversations";
import { matchMysteryShopEmail } from "@/lib/prospecting/mystery-shop/inbound";
import type { MailboxConnection, MailboxCursor } from "@/types/mailbox";
export function cursorWindow(
  cursor: MailboxCursor | undefined,
  validity: string,
  uidNext: number
) {
  const reset = cursor?.uidValidity !== validity;
  const start = reset ? 1 : cursor.uid + 1;
  return { start, end: Math.min(start + 999, uidNext - 1), reset };
}
export async function syncMailbox(subAccountId: string) {
  const db = getAdminDb(),
    ref = db.doc(`subAccounts/${subAccountId}/private/mailboxConnection`),
    token = randomUUID();
  const connection = await db.runTransaction(async (tx) => {
    const c = (await tx.get(ref)).data() as MailboxConnection | undefined;
    if (!c?.enabled || !c.verifiedAt)
      throw new MailboxError("Mailbox is not connected.", 409);
    if (c.leaseUntil > Date.now())
      throw new MailboxError("Mailbox sync is already running.", 409);
    tx.update(ref, {
      leaseToken: token,
      leaseUntil: Date.now() + 90000,
      nextFolder:
        c.sentFolder && c.nextFolder !== c.sentFolder ? c.sentFolder : "INBOX",
    });
    return c;
  });
  const summary = { imported: 0, skipped: 0, hasMore: false };
  // Set when this pass reads the INBOX to its end: the mystery-shop missed verdict waits for it.
  let inboxCaughtUp = false;
  const checkpoint = async (
    cursors: Record<string, MailboxCursor>,
    finish = false,
    error: string | null = null
  ) =>
    db.runTransaction(async (tx) => {
      const live = (await tx.get(ref)).data() as MailboxConnection | undefined;
      if (
        live?.version !== connection.version ||
        live.leaseToken !== token ||
        live.leaseUntil <= Date.now()
      )
        throw new MailboxError(
          "Mailbox settings changed. Start sync again.",
          409
        );
      tx.update(ref, {
        cursors,
        ...(finish
          ? {
              leaseToken: null,
              leaseUntil: 0,
              lastError: error,
              ...(!error ? { lastSyncAt: new Date().toISOString() } : {}),
            }
          : {}),
      });
      if (finish)
        tx.update(db.doc(`subAccounts/${subAccountId}`), {
          "mailboxConfig.lastError": error,
          ...(!error
            ? { "mailboxConfig.lastSyncAt": new Date().toISOString() }
            : {}),
          ...(!error && inboxCaughtUp ? { "mailboxConfig.inboxCaughtUpAt": new Date(started).toISOString() } : {}),
        });
    });
  let client: Awaited<ReturnType<typeof connectMailbox>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = Date.now();
  let processed = 0;
  try {
    client = await connectMailbox(connection);
    timer = setTimeout(() => client?.close(), 45000);
    const folders = [
      ...new Set([
        "INBOX",
        ...(connection.sentFolder ? [connection.sentFolder] : []),
      ]),
    ];
    if (connection.nextFolder === connection.sentFolder) folders.reverse();
    const folderLimit = Math.floor(20 / folders.length);
    for (const folder of folders) {
      let folderProcessed = 0;
      if (processed >= 20 || Date.now() - started > 35000) {
        summary.hasMore = true;
        break;
      }
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        if (!client.mailbox)
          throw new MailboxError("Mailbox could not be opened.", 502);
        const validity = String(client.mailbox.uidValidity),
          next = client.mailbox.uidNext;
        const window = cursorWindow(connection.cursors[folder], validity, next);
        const cursor: MailboxCursor = window.reset
          ? { uidValidity: validity, uid: 0, initialComplete: false }
          : { ...connection.cursors[folder] };
        connection.cursors[folder] = cursor;
        if (window.end < window.start) {
          cursor.initialComplete = true;
          inboxCaughtUp ||= folder === "INBOX";
          await checkpoint(connection.cursors);
          continue;
        }
        const found = await client.search(
          {
            uid: `${window.start}:${window.end}`,
            ...(!cursor.initialComplete
              ? { since: new Date(connection.initialSince) }
              : {}),
          },
          { uid: true }
        );
        const uids = (found || [])
          .filter((uid) => uid >= window.start && uid <= window.end)
          .sort((a, b) => a - b);
        let completed = true;
        for (const uid of uids) {
          if (
            folderProcessed >= folderLimit ||
            processed >= 20 ||
            Date.now() - started > 35000
          ) {
            completed = false;
            summary.hasMore = true;
            break;
          }
          const metadata = await client.fetchOne(
            uid,
            {
              size: true,
              internalDate: true,
              envelope: true,
              // The mystery-shop matcher's signals, so the placeholder path reads them too.
              headers: ["X-CrestaHQ-Archive", "Authentication-Results", "Auto-Submitted", "X-Autoreply", "X-Autorespond",
                "Precedence", "List-Id", "List-Unsubscribe", "Content-Type", "X-MS-Exchange-Message-Is-Ndr", "X-Failed-Recipients"],
            },
            { uid: true }
          );
          if (!metadata) {
            cursor.uid = uid;
            await checkpoint(connection.cursors);
            continue;
          }
          let parsed: Awaited<ReturnType<typeof parseMailboxMessage>>;
          const placeholder = (body: string): typeof parsed => {
            const envelope = metadata.envelope;
            const from = envelope?.from?.[0]?.address?.toLowerCase();
            if (!from)
              throw new MailboxError(
                "A message has no usable sender. Open the original mailbox to resolve it.",
                422
              );
            return {
              from,
              to: [
                ...(envelope?.to ?? []),
                ...(envelope?.cc ?? []),
                ...(envelope?.bcc ?? []),
              ].flatMap((a) => (a.address ? [a.address.toLowerCase()] : [])),
              subject: envelope?.subject ?? "",
              body,
              messageId:
                envelope?.messageId ??
                `<${connection.version}-${validity}-${uid}-${Buffer.from(folder).toString("hex")}@import.local>`,
              inReplyTo: envelope?.inReplyTo ?? null,
              references: [],
              attachments: [],
              date: envelope?.date,
              archive: !/^x-crestahq-archive:\s*no\s*$/im.test(
                metadata.headers?.toString() ?? ""
              ),
              signals: mailSignalsFromRaw(metadata.headers?.toString() ?? ""),
            };
          };
          if (
            metadata.size === undefined ||
            metadata.size > MAX_MESSAGE_BYTES
          ) {
            parsed = placeholder(
              "Message body exceeds the 5 MB import limit. Open the original mailbox to read it and its attachments."
            );
            summary.skipped++;
          } else {
            const message = await client.fetchOne(
              uid,
              { source: { start: 0, maxLength: MAX_MESSAGE_BYTES + 1 } },
              { uid: true }
            );
            if (!message || !message.source)
              throw new MailboxError(
                "A mailbox message could not be read. Retry sync.",
                502
              );
            try {
              parsed = await parseMailboxMessage(message.source);
            } catch {
              parsed = placeholder(
                "Message body could not be parsed. Open the original mailbox to read it and its attachments."
              );
              summary.skipped++;
            }
          }
          if (!parsed.from)
            throw new MailboxError(
              "A message has no usable sender. Open the original mailbox to resolve it.",
              422
            );
          const direction =
            folder === connection.sentFolder ? "outbound" : "inbound";
          const own = new Set(connection.ownAddresses);
          const to =
            direction === "outbound"
              ? parsed.to.filter((a) => !own.has(a))
              : parsed.to.length
                ? parsed.to
                : [connection.ownAddresses[0]];
          if (
            (direction === "outbound" &&
              own.has(parsed.from) &&
              !parsed.archive) ||
            !parsed.from ||
            (direction === "inbound" && own.has(parsed.from)) ||
            (direction === "outbound" && !to.length)
          )
            summary.skipped++;
          else {
            const { date, archive: _archive, signals, ...input } = parsed;
            const occurredAt =
              metadata.internalDate instanceof Date
                ? metadata.internalDate
                : date instanceof Date && !Number.isNaN(date.getTime())
                  ? date
                  : new Date();
            const result = await recordEmailMessage({
              ...input,
              to,
              subAccountId,
              direction,
              occurredAt,
              historical:
                occurredAt.getTime() <=
                new Date(connection.verifiedAt).getTime(),
              mailboxFence: { version: connection.version, leaseToken: token },
            });
            if (result.inserted) summary.imported++;
            else summary.skipped++;
            if (direction === "inbound")
              await matchMysteryShopEmail(subAccountId, { ...input, ...signals, occurredAtMs: occurredAt.getTime() })
                .catch((err) => console.error("[mailbox-sync] mystery-shop match failed", subAccountId, err));
          }
          processed++;
          folderProcessed++;
          cursor.uid = uid;
          await checkpoint(connection.cursors);
        }
        if (completed) {
          cursor.uid = window.end;
          if (window.end >= next - 1) {
            cursor.initialComplete = true;
            inboxCaughtUp ||= folder === "INBOX";
          } else summary.hasMore = true;
          await checkpoint(connection.cursors);
        }
      } finally {
        lock.release();
      }
    }
    await checkpoint(connection.cursors, true);
    return summary;
  } catch (error) {
    const safe = mailboxPublicError(error);
    await checkpoint(connection.cursors, true, safe.message).catch(() => {});
    throw safe;
  } finally {
    clearTimeout(timer);
    client?.close();
  }
}
/** A paged sweep isolates failures and uses a stable document cursor for continuation. */
export async function runMailboxSweep(after?: string) {
  let query = getAdminDb()
    .collection("subAccounts")
    .where("mailboxConfig.enabled", "==", true)
    .orderBy("__name__")
    .limit(3);
  if (after) query = query.startAfter(after);
  const docs = (await query.get()).docs;
  const results = [];
  for (const doc of docs) {
    try {
      results.push({ subAccountId: doc.id, ...(await syncMailbox(doc.id)) });
    } catch {
      results.push({ subAccountId: doc.id, failed: true });
    }
  }
  return {
    results,
    hasMore: docs.length === 3,
    nextAfter: docs.at(-1)?.id ?? null,
  };
}
