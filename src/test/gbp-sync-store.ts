import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The in-memory Firestore + Auth behind gbp-sync-harness. Its own module with
 * NO app imports, because `vi.mock("@/lib/firebase/admin")` loads it: a mock
 * factory that imported app code importing the admin module would deadlock.
 *
 *   vi.mock("@/lib/firebase/admin", async () =>
 *     (await import("@/test/gbp-sync-store")).adminMock());
 */

export const mem = createMemoryFirestore();
export const claims = new Map<string, Record<string, unknown>>();

type Tx = Parameters<Parameters<typeof mem.db.runTransaction>[0]>[0];
type Ref = ReturnType<typeof mem.db.doc>;

/** WriteBatch over the store's transaction: all-or-nothing, like Firestore's. */
function batch() {
  const ops: Array<(tx: Tx) => void> = [];
  const b = {
    set: (ref: Ref, data: Record<string, unknown>, opts?: { merge?: boolean }) =>
      (ops.push((tx) => tx.set(ref, data, opts)), b),
    update: (ref: Ref, data: Record<string, unknown>) => (ops.push((tx) => tx.update(ref, data)), b),
    create: (ref: Ref, data: Record<string, unknown>) => (ops.push((tx) => tx.create(ref, data)), b),
    delete: (ref: Ref) => (ops.push((tx) => tx.delete(ref)), b),
    commit: () => mem.db.runTransaction(async (tx) => void ops.forEach((op) => op(tx))),
  };
  return b;
}

/** What getAdminDb() returns — spy on THIS (not mem.db) to observe or fault reads/writes. */
export const storeDb = { ...mem.db, batch };

export const adminMock = () => ({
  getAdminDb: () => storeDb,
  getAdminAuth: () => ({
    getUser: async (uid: string) => ({ customClaims: claims.get(uid) ?? {} }),
  }),
});
