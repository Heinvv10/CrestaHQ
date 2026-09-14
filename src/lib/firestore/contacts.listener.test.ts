import { beforeEach, expect, it, vi } from "vitest";

/**
 * With the contacts page's newest-page preview in flight, the full listener's
 * first snapshot can come from the in-memory cache holding only those docs.
 * Measured live 2026-09-14: a 100-of-4,689 table shown as complete for ~1.4s.
 * `waitForServer` holds the callback until the server has answered.
 */
type Next = (snap: unknown) => void;
const m = vi.hoisted(() => ({
  onSnapshot: vi.fn(),
  next: null as Next | null,
  options: null as unknown,
}));
vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  doc: vi.fn(),
  addDoc: vi.fn(),
  updateDoc: vi.fn(),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  limit: vi.fn(),
  onSnapshot: m.onSnapshot,
  serverTimestamp: vi.fn(),
  query: vi.fn(),
  orderBy: vi.fn(),
  where: vi.fn(),
}));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
import { subscribeToContacts } from "./contacts";

const SCOPE = { agencyId: "ag1", subAccountId: "sa1" };

function snap(ids: string[], fromCache: boolean) {
  return {
    metadata: { fromCache },
    docs: ids.map((id) => ({ id, data: () => ({ createdAt: null }) })),
  };
}

beforeEach(() => {
  m.onSnapshot.mockReset();
  m.onSnapshot.mockImplementation((_q: unknown, options: unknown, next: Next) => {
    m.options = options;
    m.next = next;
    return () => undefined;
  });
});

it("waitForServer: a partial cache snapshot is held; the server answer is delivered", () => {
  const cb = vi.fn();
  subscribeToContacts(SCOPE, { waitForServer: true }, cb);
  expect(m.options).toEqual({ includeMetadataChanges: true });
  m.next!(snap(["c1"], true));
  expect(cb).not.toHaveBeenCalled();
  m.next!(snap(["c1", "c2", "c3"], false));
  expect(cb).toHaveBeenCalledTimes(1);
  expect(cb.mock.calls[0][0].map((c: { id: string }) => c.id).sort()).toEqual(["c1", "c2", "c3"]);
});

it("waitForServer: once the server has answered, later cache snapshots (offline) still flow", () => {
  const cb = vi.fn();
  subscribeToContacts(SCOPE, { waitForServer: true }, cb);
  m.next!(snap(["c1", "c2"], false));
  m.next!(snap(["c1"], true));
  expect(cb).toHaveBeenCalledTimes(2);
});

it("without waitForServer, behaviour is unchanged: cache snapshots flow at once", () => {
  const cb = vi.fn();
  subscribeToContacts(SCOPE, {}, cb);
  expect(m.options).toEqual({ includeMetadataChanges: false });
  m.next!(snap(["c1"], true));
  expect(cb).toHaveBeenCalledTimes(1);
});
