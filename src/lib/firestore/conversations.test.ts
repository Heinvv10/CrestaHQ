import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, path: string) => path,
  where: (...args: unknown[]) => args,
  query: (...args: unknown[]) => args,
  onSnapshot: m.listen,
  doc: vi.fn(),
  serverTimestamp: vi.fn(),
  updateDoc: vi.fn(),
}));
import { subscribeToConversations } from "./conversations";
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
