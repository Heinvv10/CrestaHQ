import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ listen: vi.fn(), getDocs: vi.fn() }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, path: string) => path,
  where: (...args: unknown[]) => args,
  query: (...args: unknown[]) => args,
  onSnapshot: m.listen,
  getDocs: m.getDocs,
  orderBy: (...args: unknown[]) => ["orderBy", ...args],
  limit: (n: number) => ["limit", n],
  doc: vi.fn(),
  serverTimestamp: vi.fn(),
  updateDoc: vi.fn(),
}));
import {
  fetchNewestConversations,
  subscribeToConversations,
  subscribeToUnreadConversationCount,
} from "./conversations";
beforeEach(() => vi.clearAllMocks());
it("constrains scoped inbox queries before subscribing", () => {
  subscribeToConversations("sa", vi.fn(), vi.fn(), ["global", "north"]);
  expect(m.listen.mock.calls[0][0]).toEqual([
    "conversations",
    ["subAccountId", "==", "sa"],
    ["territoryId", "in", ["global", "north"]],
  ]);
});
it("never issues a broad query for an empty scope", () => {
  const receive = vi.fn();
  subscribeToConversations("sa", receive, vi.fn(), []);
  expect(m.listen).not.toHaveBeenCalled();
  expect(receive).toHaveBeenCalledWith([]);
});

it("the unread badge queries only unread conversations, territory-scoped", () => {
  subscribeToUnreadConversationCount("sa", vi.fn(), vi.fn(), ["north"]);
  expect(m.listen.mock.calls[0][0]).toEqual([
    "conversations",
    ["subAccountId", "==", "sa"],
    ["territoryId", "in", ["north"]],
    ["unreadCount", ">", 0],
  ]);
});
it("the unread badge counts the matching docs", () => {
  const receive = vi.fn();
  subscribeToUnreadConversationCount("sa", receive);
  const next = m.listen.mock.calls[0][1] as (s: { size: number }) => void;
  next({ size: 7 });
  expect(receive).toHaveBeenCalledWith(7);
});
it("the unread badge never issues a broad query for an empty scope", () => {
  const receive = vi.fn();
  subscribeToUnreadConversationCount("sa", receive, vi.fn(), []);
  expect(m.listen).not.toHaveBeenCalled();
  expect(receive).toHaveBeenCalledWith(0);
});
it("the preview fetches the most recently active page for the sub-account", async () => {
  m.getDocs.mockResolvedValue({
    docs: [{ id: "c1", data: () => ({ subAccountId: "sa" }) }],
  });
  const rows = await fetchNewestConversations("sa", 100);
  expect(m.getDocs.mock.calls[0][0]).toEqual([
    "conversations",
    ["subAccountId", "==", "sa"],
    ["orderBy", "lastMessageAt", "desc"],
    ["limit", 100],
  ]);
  expect(rows).toEqual([{ id: "c1", subAccountId: "sa" }]);
});

/**
 * The preview and the unread badge seed Firestore's cache with a subset of
 * the inbox, so the full listener's first snapshot can come from cache with
 * only those docs. `waitForServer` holds the callback until the server has
 * answered.
 */
type Snap = {
  metadata: { fromCache: boolean };
  docs: { id: string; data: () => object }[];
  docChanges: () => unknown[];
};
function snap(ids: string[], fromCache: boolean, changes = ids.length): Snap {
  return {
    metadata: { fromCache },
    docs: ids.map((id) => ({ id, data: () => ({ lastMessageAt: null }) })),
    docChanges: () => Array.from({ length: changes }),
  };
}
function subscribe(waitForServer: boolean) {
  const cb = vi.fn();
  subscribeToConversations("sa", cb, vi.fn(), null, { waitForServer });
  const [, options, next] = m.listen.mock.calls[0] as [
    unknown,
    unknown,
    (s: Snap) => void,
  ];
  return { cb, options, next };
}
it("waitForServer: a partial cache snapshot is held; the server answer is delivered", () => {
  const { cb, options, next } = subscribe(true);
  expect(options).toEqual({ includeMetadataChanges: true });
  next(snap(["c1"], true));
  expect(cb).not.toHaveBeenCalled();
  next(snap(["c1", "c2", "c3"], false));
  expect(cb).toHaveBeenCalledTimes(1);
  expect(cb.mock.calls[0][0]).toHaveLength(3);
});
it("waitForServer: cache-only snapshots (offline, server never answers) are never delivered", () => {
  // Deliberate: a partial cache shown as a complete inbox is worse than
  // waiting — the pane says it is offline / slow instead.
  const { cb, next } = subscribe(true);
  next(snap(["c1"], true));
  next(snap(["c1", "c2"], true, 1));
  next(snap(["c1", "c2"], true, 0));
  expect(cb).not.toHaveBeenCalled();
});
it("waitForServer: a warm, complete cache loads on the server's metadata-only confirmation", () => {
  const { cb, next } = subscribe(true);
  next(snap(["c1", "c2"], true));
  next(snap(["c1", "c2"], false, 0));
  expect(cb).toHaveBeenCalledTimes(1);
});
it("waitForServer: after loading, real changes flow and metadata-only events are skipped", () => {
  const { cb, next } = subscribe(true);
  next(snap(["c1"], false));
  next(snap(["c1", "c2"], false, 1)); // a new conversation
  next(snap(["c1", "c2"], false, 0)); // a write ack: metadata only
  next(snap(["c2"], true, 1)); // a removal seen while offline
  expect(cb).toHaveBeenCalledTimes(3);
});
it("without waitForServer, cache snapshots flow at once", () => {
  const { cb, options, next } = subscribe(false);
  expect(options).toEqual({ includeMetadataChanges: false });
  next(snap(["c1"], true));
  expect(cb).toHaveBeenCalledTimes(1);
});
