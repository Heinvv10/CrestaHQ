import { vi } from "vitest";

/**
 * Shared test harness for the Firestore half of
 * `src/lib/comms/ai/capture.ts`.
 *
 * Its tests live in two files (contact reconciliation vs the backfill guards)
 * to stay under the 300-line file cap; both need the same Firestore double, so
 * it lives here once. Vitest isolates module state per test file, so each file
 * gets a fresh copy of the stores and spies.
 */

export interface FakeContact {
  id: string;
  data: Record<string, unknown>;
}

export let contacts: FakeContact[] = [];
export let subAccountDoc: Record<string, unknown> | undefined;
/** Every doc.ref.update() the code issued, in order. */
export const updates: Array<{ id: string; patch: Record<string, unknown> }> =
  [];
/** Every contacts collection add() payload. */
export const adds: Array<Record<string, unknown>> = [];
/** When true the next update() rejects (exercises the swallow-errors path). */
export let updateThrows = false;

export function setSubAccountDoc(doc: Record<string, unknown> | undefined) {
  subAccountDoc = doc;
}
export function setUpdateThrows(v: boolean) {
  updateThrows = v;
}

function snapFor(c: FakeContact) {
  return {
    id: c.id,
    data: () => c.data,
    ref: {
      update: async (patch: Record<string, unknown>) => {
        if (updateThrows) throw new Error("write failed");
        updates.push({ id: c.id, patch });
        Object.assign(c.data, patch);
      },
    },
  };
}

/** Firestore queries are immutable — each where() returns a NEW query, so a
 *  reused collection reference can't leak filters between lookups. */
function contactsQuery(filters: Array<[string, unknown]> = []) {
  const q = {
    where: (field: string, _op: string, value: unknown) =>
      contactsQuery([...filters, [field, value]]),
    limit: () => q,
    get: async () => {
      const hits = contacts.filter((c) =>
        filters.every(([f, v]) => c.data[f] === v)
      );
      return { empty: hits.length === 0, docs: hits.map(snapFor) };
    },
    add: async (data: Record<string, unknown>) => {
      adds.push(data);
      const id = `new${adds.length}`;
      contacts.push({ id, data });
      return { id };
    },
  };
  return q;
}

export const getAdminDb = vi.fn(() => ({
  collection: (name: string) => {
    if (name !== "contacts") throw new Error(`unexpected collection ${name}`);
    return contactsQuery();
  },
  doc: (path: string) => ({
    get: async () => ({
      exists: path.startsWith("subAccounts/") && subAccountDoc !== undefined,
      data: () => subAccountDoc,
    }),
  }),
}));

export const emitContactCreated = vi.fn(async () => undefined);

// ---- fixtures ---------------------------------------------------------

export const SA = "sa1";
export const AG = "ag1";

/** Seed an existing contact in the sub-account (blank name/email/phone by
 *  default so a test only states the fields it cares about). */
export function existing(id: string, data: Record<string, unknown>) {
  contacts.push({
    id,
    data: { subAccountId: SA, name: "", email: "", phone: "", ...data },
  });
}

/** Reset stores + spies. Call from the test file's beforeEach. */
export function resetHarness() {
  contacts = [];
  updates.length = 0;
  adds.length = 0;
  updateThrows = false;
  subAccountDoc = { defaultPhoneCountry: "AU" };
  vi.clearAllMocks();
}
