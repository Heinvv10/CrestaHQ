import { beforeEach, expect, it, vi } from "vitest";
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
