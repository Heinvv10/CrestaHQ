import { beforeEach, expect, it, vi } from "vitest";
import { parseMailboxMessage } from "@/lib/comms/imap";
const m = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => db }));
const ref = (path: string) => ({ path, id: path.split("/").at(-1) });
const snap = (path: string) => ({
  exists: m.rows.has(path),
  id: path.split("/").at(-1),
  data: () => m.rows.get(path),
});
const db = {
  doc: ref,
  collection: (path: string) => {
    const filters: [string, unknown][] = [];
    let pageLimit = Infinity;
    let afterId = "";
    const query = {
      path,
      filters,
      where: (key: string, _op: string, value: unknown) => {
        filters.push([key, value]);
        return query;
      },
      limit: (count: number) => {
        pageLimit = count;
        return query;
      },
      orderBy: () => query,
      // Contact-scoped subcollection writes (the timeline row the helper
      // adds after the transaction). Not part of any query above.
      doc: (id: string) => ({
        ...ref(`${path}/${id}`),
        collection: (sub: string) => ({
          doc: (docId?: string) => ({
            set: async (data: Record<string, unknown>) => {
              m.rows.set(`${path}/${id}/${sub}/${docId ?? "auto"}`, data);
            },
          }),
        }),
      }),
      startAfter: (doc: { id: string }) => {
        afterId = doc.id;
        return query;
      },
      get: async () => ({
        docs: [...m.rows.keys()]
          .filter(
            (p) =>
              p.split("/").length === 2 &&
              p.startsWith(path + "/") &&
              p.split("/")[1] > afterId &&
              filters.every(([k, v]) => m.rows.get(p)?.[k] === v)
          )
          .sort()
          .slice(0, pageLimit)
          .map((p) => ({ ...snap(p), ref: ref(p) })),
      }),
    };

    return query;
  },
  runTransaction: async (fn: (tx: unknown) => unknown) => {
    const writes: (() => void)[] = [];
    const tx = {
      get: async (r: { path: string; filters?: [string, unknown][] }) =>
        r.filters
          ? {
              docs: [...m.rows.keys()]
                .filter(
                  (p) =>
                    p.split("/").length === 2 &&
                    p.startsWith(r.path + "/") &&
                    r.filters!.every(([k, v]) => m.rows.get(p)?.[k] === v)
                )
                .map((p) => ({ ...snap(p), ref: ref(p) })),
            }
          : snap(r.path),
      set: (
        r: { path: string },
        data: Record<string, unknown>,
        options?: { merge: boolean }
      ) =>
        writes.push(() =>
          m.rows.set(r.path, {
            ...(options?.merge ? m.rows.get(r.path) : {}),
            ...data,
          })
        ),
    };
    const result = await fn(tx);
    writes.forEach((w) => w());
    return result;
  },
};
let recordEmailMessage: typeof import("./email-conversations").recordEmailMessage;
const input = {
  subAccountId: "sa",
  direction: "inbound" as const,
  subject: "Hello",
  body: "Latest",
  from: "friend@example.com",
  to: ["me@example.com"],
  messageId: "<one@example.com>",
  occurredAt: new Date("2026-09-08"),
  historical: false,
};
beforeEach(async () => {
  vi.resetModules();
  recordEmailMessage = (await import("./email-conversations"))
    .recordEmailMessage;
  m.rows.clear();
  m.rows.set("subAccounts/sa", { agencyId: "agency" });
});
it("atomically creates a tenant contact, message and conversation and dedupes", async () => {
  const first = await recordEmailMessage(input);
  expect(first.inserted).toBe(true);
  expect(await recordEmailMessage(input)).toEqual({
    ...first,
    inserted: false,
  });
  expect(m.rows.get(`contacts/${first.contactId}`)).toMatchObject({
    email: input.from,
    subAccountId: "sa",
    agencyId: "agency",
  });
  expect(m.rows.get(`conversations/${first.contactId}`)).toMatchObject({
    unreadCount: 1,
    lastChannel: "email",
    lastMessagePreview: "Latest",
  });
  expect(
    [...m.rows.keys()].filter((k) => k.includes("/emailMessages/"))
  ).toHaveLength(1);
  // One timeline row for the new inbound mail; the dedupe wrote none.
  expect([...m.rows.keys()].filter((k) => k.includes("/activities/"))).toEqual([
    `contacts/${first.contactId}/activities/inbound_email_<one@example.com>`,
  ]);
  expect(
    m.rows.get(
      `contacts/${first.contactId}/activities/inbound_email_<one@example.com>`
    )
  ).toMatchObject({
    type: "email_received",
    createdBy: "email_inbound",
    agencyId: "agency",
    subAccountId: "sa",
    content: "Email received: Hello — Latest",
    meta: { channel: "email", messageId: "<one@example.com>" },
  });
});
it("historical mail preserves newer previews and unread counts", async () => {
  const first = await recordEmailMessage(input);
  await recordEmailMessage({
    ...input,
    messageId: "<old@example.com>",
    body: "Old",
    historical: true,
    occurredAt: new Date("2020-01-01"),
  });
  expect(m.rows.get(`conversations/${first.contactId}`)).toMatchObject({
    unreadCount: 1,
    lastMessagePreview: "Latest",
  });
  // Backfilled mail stays off the timeline.
  expect([...m.rows.keys()].filter((k) => k.includes("/activities/"))).toEqual([
    `contacts/${first.contactId}/activities/inbound_email_<one@example.com>`,
  ]);
});
it("rejects an explicit cross-tenant contact before any writes", async () => {
  m.rows.set("contacts/foreign", {
    subAccountId: "other",
    agencyId: "agency",
    email: input.from,
  });
  const size = m.rows.size;
  await expect(
    recordEmailMessage({ ...input, contactId: "foreign" })
  ).rejects.toThrow(/tenant/i);
  expect(m.rows.size).toBe(size);
});
it("finds existing contacts and records every outbound recipient", async () => {
  m.rows.set("contacts/existing", {
    subAccountId: "sa",
    agencyId: "agency",
    email: "friend@example.com",
    name: "Friend",
  });
  await recordEmailMessage({
    ...input,
    direction: "outbound",
    from: "me@example.com",
    to: ["friend@example.com", "second@example.com"],
  });
  expect(
    [...m.rows.keys()].filter((k) => k.includes("/emailMessages/"))
  ).toHaveLength(2);
  expect(m.rows.get("conversations/existing")).toMatchObject({
    unreadCount: 0,
  });
});
it("does not leave any partial writes when an index belongs to another tenant", async () => {
  m.rows.set("contacts/existing", {
    subAccountId: "sa",
    agencyId: "agency",
    email: input.from,
  });
  m.rows.set("conversations/existing", {
    subAccountId: "other",
    agencyId: "agency",
  });
  await expect(recordEmailMessage(input)).rejects.toThrow(/tenant/i);
  expect(
    [...m.rows.keys()].filter((k) => k.includes("/emailMessages/"))
  ).toHaveLength(0);
});
it("rejects a stale mailbox worker without writes", async () => {
  m.rows.set("subAccounts/sa/private/mailboxConnection", {
    version: "new",
    leaseToken: "new-token",
    leaseUntil: Date.now() + 90000,
  });
  await expect(
    recordEmailMessage({
      ...input,
      mailboxFence: { version: "old", leaseToken: "old-token" },
    })
  ).rejects.toThrow(/lease|changed/i);
  expect(
    [...m.rows.keys()].filter((k) => k.includes("/emailMessages/"))
  ).toHaveLength(0);
});
it("matches a legacy mixed-case email before creating a contact", async () => {
  m.rows.set("contacts/legacy", {
    subAccountId: "sa",
    agencyId: "agency",
    email: "Friend@Example.com",
  });
  expect((await recordEmailMessage(input)).contactId).toBe("legacy");
});
it("supports explicit contact plus additional outbound recipients", async () => {
  m.rows.set("contacts/known", {
    subAccountId: "sa",
    agencyId: "agency",
    email: "friend@example.com",
  });
  await recordEmailMessage({
    ...input,
    direction: "outbound",
    contactId: "known",
    from: "me@example.com",
    to: ["friend@example.com", "second@example.com"],
  });
  expect(
    [...m.rows.keys()].filter((k) => k.includes("/emailMessages/"))
  ).toHaveLength(2);
});
it("dedupes Sent import against the original explicit contact when emails are duplicated", async () => {
  m.rows.set("contacts/a", {
    subAccountId: "sa",
    agencyId: "agency",
    email: "friend@example.com",
  });
  m.rows.set("contacts/b", {
    subAccountId: "sa",
    agencyId: "agency",
    email: "friend@example.com",
  });
  await recordEmailMessage({
    ...input,
    contactId: "b",
    direction: "outbound",
    from: "me@example.com",
    to: ["friend@example.com"],
  });
  expect(
    await recordEmailMessage({
      ...input,
      direction: "outbound",
      from: "me@example.com",
      to: ["friend@example.com"],
      historical: true,
    })
  ).toEqual({ contactId: "b", inserted: false });
  expect(
    [...m.rows.keys()].filter((k) => k.includes("/emailMessages/"))
  ).toHaveLength(1);
  // Outbound mail is not an inbound activity.
  expect([...m.rows.keys()].filter((k) => k.includes("/activities/"))).toEqual([]);
});

it("pages beyond five thousand contacts to resolve mixed-case addresses", async () => {
  for (let i = 0; i < 5100; i++)
    m.rows.set(`contacts/c${String(i).padStart(5, "0")}`, {
      subAccountId: "sa",
      agencyId: "agency",
      email: `user${i}@example.com`,
    });
  m.rows.set("contacts/z-last", {
    subAccountId: "sa",
    agencyId: "agency",
    email: "Friend@Example.com",
  });
  expect((await recordEmailMessage(input)).contactId).toBe("z-last");
});
it("concurrent imports share one deterministic unknown contact", async () => {
  const results = await Promise.all([
    recordEmailMessage(input),
    recordEmailMessage(input),
  ]);
  expect(results[0].contactId).toBe(results[1].contactId);
  expect(
    [...m.rows.keys()].filter(
      (k) => k.startsWith("contacts/") && k.split("/").length === 2
    )
  ).toHaveLength(1);
});
it("separates the same email and RFC id across tenants", async () => {
  m.rows.set("subAccounts/other", { agencyId: "other-agency" });
  const a = await recordEmailMessage(input);
  const b = await recordEmailMessage({ ...input, subAccountId: "other" });
  expect(a.contactId).not.toBe(b.contactId);
  expect(m.rows.get(`contacts/${b.contactId}`)).toMatchObject({
    subAccountId: "other",
    agencyId: "other-agency",
  });
});
it("carries restricted contact territory into inbox preview", async () => {
  m.rows.set("contacts/known", {
    subAccountId: "sa",
    agencyId: "agency",
    email: input.from,
    territoryId: "restricted",
  });
  await recordEmailMessage({ ...input, contactId: "known" });
  expect(m.rows.get("conversations/known")).toMatchObject({
    territoryId: "restricted",
  });
});
it("does not make legacy unassigned contacts globally visible", async () => {
  m.rows.set("contacts/known", {
    subAccountId: "sa",
    agencyId: "agency",
    email: input.from,
  });
  await recordEmailMessage({ ...input, contactId: "known" });
  expect(m.rows.get("conversations/known")).toMatchObject({
    territoryId: null,
  });
});

// ---- Threading: how an inbound reply finds its conversation ---------------
// Conversations are keyed by contact, and an inbound mail's contact is found
// by the SENDER'S ADDRESS. In-Reply-To/References are stored on the row and
// only break a tie between contacts sharing that address.
const SENT_ID = "<sent@desk.example.com>";
async function recordRawInbound(raw: string) {
  const { date: _date, archive: _archive, ...fields } =
    await parseMailboxMessage(Buffer.from(raw));
  return recordEmailMessage({
    ...fields,
    subAccountId: "sa",
    direction: "inbound",
    occurredAt: new Date("2026-09-09"),
    historical: false,
  });
}
const replyFrom = (from: string) =>
  [
    `From: Friend <${from}>`,
    "To: me@example.com",
    "Subject: Re: Quote",
    "Message-ID: <reply@friend.example.com>",
    `In-Reply-To: ${SENT_ID}`,
    `References: <root@desk.example.com> ${SENT_ID}`,
    "",
    "Sounds good.",
  ].join("\r\n");
async function sendFrom(contactId: string) {
  await recordEmailMessage({
    ...input,
    contactId,
    direction: "outbound",
    subject: "Quote",
    body: "Here is the quote.",
    from: "me@example.com",
    to: ["friend@example.com"],
    messageId: SENT_ID,
    occurredAt: new Date("2026-09-08"),
  });
}
const emailRows = (contactId: string) =>
  [...m.rows.keys()].filter((k) =>
    k.startsWith(`contacts/${contactId}/emailMessages/`)
  );
it("an inbound reply parsed from raw mail lands in the conversation it answers, headers kept", async () => {
  m.rows.set("contacts/known", {
    subAccountId: "sa",
    agencyId: "agency",
    email: "friend@example.com",
  });
  await sendFrom("known");
  expect((await recordRawInbound(replyFrom("friend@example.com"))).contactId).toBe("known");
  expect(emailRows("known")).toHaveLength(2);
  const inbound = emailRows("known")
    .map((k) => m.rows.get(k)!)
    .find((row) => row.direction === "inbound");
  expect(inbound).toMatchObject({
    subject: "Re: Quote",
    messageId: "<reply@friend.example.com>",
    inReplyTo: SENT_ID,
    references: ["<root@desk.example.com>", SENT_ID],
  });
  expect(m.rows.get("conversations/known")).toMatchObject({
    lastDirection: "inbound",
    unreadCount: 1,
  });
});
it("when two contacts share the address, a reply follows the contact its parent was sent from", async () => {
  for (const id of ["a", "b"])
    m.rows.set(`contacts/${id}`, {
      subAccountId: "sa",
      agencyId: "agency",
      email: "friend@example.com",
    });
  await sendFrom("b");
  expect((await recordRawInbound(replyFrom("friend@example.com"))).contactId).toBe("b");
  expect(emailRows("a")).toHaveLength(0);
});
it("a reply from a different address starts that address's own contact, even when it references our mail", async () => {
  m.rows.set("contacts/known", {
    subAccountId: "sa",
    agencyId: "agency",
    email: "friend@example.com",
  });
  await sendFrom("known");
  const { contactId } = await recordRawInbound(replyFrom("alias@example.com"));
  expect(contactId).not.toBe("known");
  expect(m.rows.get(`contacts/${contactId}`)).toMatchObject({
    email: "alias@example.com",
  });
  expect(emailRows("known")).toHaveLength(1);
});
it("ignores a parent's contact whose address has since changed instead of failing the import", async () => {
  for (const id of ["a", "b"])
    m.rows.set(`contacts/${id}`, {
      subAccountId: "sa",
      agencyId: "agency",
      email: "friend@example.com",
    });
  await sendFrom("b");
  m.rows.set("contacts/b", { ...m.rows.get("contacts/b"), email: "moved@example.com" });
  expect((await recordRawInbound(replyFrom("friend@example.com"))).contactId).toBe("a");
});
