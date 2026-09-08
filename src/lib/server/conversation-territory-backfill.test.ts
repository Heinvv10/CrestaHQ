import { expect, it } from "vitest";
import { backfillConversationTerritories } from "../../../scripts/backfill-conversation-territories";
it("dry-runs safely, applies authoritative territory, and remains idempotent", async () => {
  const rows = new Map<string, Record<string, unknown>>([
    [
      "conversations/c",
      {
        contactId: "c",
        subAccountId: "sa",
        agencyId: "agency",
        territoryId: "global",
      },
    ],
    [
      "contacts/c",
      { subAccountId: "sa", agencyId: "agency", territoryId: "private" },
    ],
    [
      "conversations/web_a",
      { contactId: null, subAccountId: "sa", agencyId: "agency" },
    ],
    [
      "conversations/orphan",
      {
        contactId: "foreign",
        subAccountId: "sa",
        agencyId: "agency",
        territoryId: "global",
      },
    ],
    [
      "contacts/foreign",
      { subAccountId: "other", agencyId: "agency", territoryId: "global" },
    ],
  ]);
  const ref = (path: string) => ({ path });
  const db = {
    doc: ref,
    collection: () => {
      const q = {
        orderBy: () => q,
        limit: () => q,
        get: async () => ({
          docs: [...rows.keys()]
            .filter((k) => k.startsWith("conversations/"))
            .map((k) => ({ id: k.split("/")[1], ref: ref(k) })),
        }),
      };
      return q;
    },
    runTransaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        get: async (r: { path: string }) => ({
          exists: rows.has(r.path),
          data: () => rows.get(r.path),
        }),
        update: (r: { path: string }, data: Record<string, unknown>) =>
          rows.set(r.path, { ...rows.get(r.path), ...data }),
      }),
  };
  expect(await backfillConversationTerritories(db as never)).toMatchObject({
    changed: 3,
    orphaned: 1,
    applied: false,
  });
  expect(rows.get("conversations/c")?.territoryId).toBe("global");
  expect(
    await backfillConversationTerritories(db as never, true)
  ).toMatchObject({ changed: 3, orphaned: 1 });
  expect(rows.get("conversations/c")?.territoryId).toBe("private");
  expect(rows.get("conversations/orphan")?.territoryId).toBeNull();
  expect(rows.get("conversations/web_a")?.territoryId).toBe("global");
  expect(
    await backfillConversationTerritories(db as never, true)
  ).toMatchObject({ changed: 0, unchanged: 3 });
});
