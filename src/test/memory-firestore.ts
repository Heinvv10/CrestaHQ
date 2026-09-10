import { FieldValue } from "firebase-admin/firestore";

/**
 * In-memory Firestore for seam tests — the ones that drive a route down
 * through the real service and the real workflow engine.
 *
 * The ad-hoc fakes elsewhere in the suite return every doc from every query.
 * That is fine for a unit that never filters, and it makes any test of "find
 * the contact with this phone" or "enrol the workflows with this trigger"
 * vacuous: the wrong query finds the right doc. This one honours `where`,
 * applies the FieldValue transforms the code writes, and yields between
 * operations so two concurrent requests genuinely interleave.
 *
 * Transactions run one at a time — the serializable guarantee Firestore
 * gives. Code that reads and writes OUTSIDE a transaction therefore races
 * here exactly as it would in production, which is the point. Not modelled:
 * a non-transactional write forcing a concurrent transaction to retry.
 *
 * Deliberately small: add an operator when a test needs it, not before.
 */

type Data = Record<string, unknown>;
type WhereOp = "==" | "in" | "array-contains";

const DELETE = Symbol("delete");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function transformOf(v: unknown): string | null {
  return v instanceof FieldValue
    ? (v as unknown as { methodName: string }).methodName
    : null;
}

function isPlainObject(v: unknown): v is Data {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    !(v instanceof FieldValue)
  );
}

function resolveValue(current: unknown, v: unknown): unknown {
  const t = transformOf(v);
  // Copy, as Firestore serializes at call time: a caller mutating its array
  // after set() must not reach into the stored doc.
  if (t === null) return Array.isArray(v) ? structuredClone(v) : v;
  const arr = Array.isArray(current) ? current : [];
  const elements = (v as unknown as { elements?: unknown[] }).elements ?? [];
  switch (t) {
    case "FieldValue.serverTimestamp":
      return new Date();
    case "FieldValue.increment":
      return (
        (typeof current === "number" ? current : 0) +
        (v as unknown as { operand: number }).operand
      );
    case "FieldValue.arrayUnion":
      return [...arr, ...elements.filter((e) => !arr.includes(e))];
    case "FieldValue.arrayRemove":
      return arr.filter((e) => !elements.includes(e));
    case "FieldValue.delete":
      return DELETE;
    default:
      throw new Error(`memory-firestore: unsupported transform ${t}`);
  }
}

function setPath(target: Data, path: string[], value: unknown): void {
  const [head, ...rest] = path;
  if (rest.length === 0) {
    const next = resolveValue(target[head], value);
    if (next === DELETE) delete target[head];
    else target[head] = next;
    return;
  }
  if (!isPlainObject(target[head])) target[head] = {};
  setPath(target[head] as Data, rest, value);
}

/** Deep-copies nested maps as it goes, resolving any transforms inside them. */
function mergeInto(target: Data, patch: Data): void {
  for (const [k, v] of Object.entries(patch)) {
    if (!isPlainObject(v)) {
      setPath(target, [k], v);
      continue;
    }
    if (!isPlainObject(target[k])) target[k] = {};
    mergeInto(target[k] as Data, v);
  }
}

function getPath(data: Data, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function matches(data: Data, field: string, op: WhereOp, value: unknown): boolean {
  const actual = getPath(data, field);
  switch (op) {
    case "==":
      return actual === value;
    case "in":
      return Array.isArray(value) && value.includes(actual);
    case "array-contains":
      return Array.isArray(actual) && actual.includes(value);
  }
}

export interface MemoryDocSnapshot {
  id: string;
  exists: boolean;
  ref: MemoryDocRef;
  data: () => Data | undefined;
}

export interface MemoryDocRef {
  id: string;
  path: string;
  get: () => Promise<MemoryDocSnapshot>;
  set: (data: Data, opts?: { merge?: boolean }) => Promise<void>;
  update: (patch: Data) => Promise<void>;
  create: (data: Data) => Promise<void>;
  delete: () => Promise<void>;
  collection: (name: string) => MemoryQuery & { doc: (id?: string) => MemoryDocRef };
}

export interface MemoryQuery {
  where: (field: string, op: WhereOp, value: unknown) => MemoryQuery;
  orderBy: (field: string, dir?: "asc" | "desc") => MemoryQuery;
  limit: (n: number) => MemoryQuery;
  get: () => Promise<{ empty: boolean; size: number; docs: MemoryDocSnapshot[] }>;
}

type TxWrite = (ref: MemoryDocRef, data: Data, opts?: { merge?: boolean }) => MemoryTx;
interface MemoryTx {
  get: (target: MemoryDocRef | MemoryQuery) => Promise<unknown>;
  set: TxWrite;
  update: TxWrite;
  create: TxWrite;
  delete: (ref: MemoryDocRef) => MemoryTx;
}

export function createMemoryFirestore() {
  const store = new Map<string, Data>();
  let autoId = 0;
  let txQueue: Promise<unknown> = Promise.resolve();

  const snapshot = (path: string): MemoryDocSnapshot => {
    const data = store.get(path);
    return {
      id: path.split("/").pop()!,
      exists: data !== undefined,
      ref: docRef(path),
      data: () => (data === undefined ? undefined : structuredClone(data)),
    };
  };

  const writeSet = (path: string, data: Data, merge: boolean) => {
    const next = merge ? structuredClone(store.get(path) ?? {}) : {};
    mergeInto(next, data);
    store.set(path, next);
  };

  const writeUpdate = (path: string, patch: Data) => {
    const current = store.get(path);
    if (current === undefined) {
      throw Object.assign(new Error(`5 NOT_FOUND: No document to update: ${path}`), {
        code: 5,
      });
    }
    const next = structuredClone(current);
    for (const [k, v] of Object.entries(patch)) setPath(next, k.split("."), v);
    store.set(path, next);
  };

  const writeCreate = (path: string, data: Data) => {
    if (store.has(path)) throw Object.assign(new Error(`6 ALREADY_EXISTS: ${path}`), { code: 6 });
    writeSet(path, data, false);
  };

  function docRef(path: string): MemoryDocRef {
    return {
      id: path.split("/").pop()!,
      path,
      get: () => tick().then(() => snapshot(path)),
      set: (data, opts) => tick().then(() => writeSet(path, data, opts?.merge === true)),
      update: (patch) => tick().then(() => writeUpdate(path, patch)),
      create: (data) => tick().then(() => writeCreate(path, data)),
      delete: () => tick().then(() => void store.delete(path)),
      collection: (name) => collectionRef(`${path}/${name}`),
    };
  }

  function query(
    collectionPath: string,
    filters: Array<[string, WhereOp, unknown]>,
    order: [string, "asc" | "desc"] | null,
    max: number | null,
  ): MemoryQuery {
    return {
      where: (f, op, v) => query(collectionPath, [...filters, [f, op, v]], order, max),
      orderBy: (f, dir = "asc") => query(collectionPath, filters, [f, dir], max),
      limit: (n) => query(collectionPath, filters, order, n),
      get: async () => {
        await tick();
        let paths = [...store.keys()].filter((p) => {
          const parent = p.slice(0, p.lastIndexOf("/"));
          if (parent !== collectionPath) return false;
          const data = store.get(p)!;
          return filters.every(([f, op, v]) => matches(data, f, op, v));
        });
        if (order) {
          const [f, dir] = order;
          const key = (p: string, v = getPath(store.get(p)!, f)) =>
            v instanceof Date ? v.getTime() : (v as number | string);
          paths.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
          if (dir === "desc") paths.reverse();
        }
        if (max !== null) paths = paths.slice(0, max);
        const docs = paths.map(snapshot);
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    };
  }

  function collectionRef(path: string) {
    return Object.assign(query(path, [], null, null), {
      doc: (id?: string) => docRef(`${path}/${id ?? `auto${++autoId}`}`),
    });
  }

  const db = {
    doc: (path: string) => docRef(path),
    collection: (path: string) => collectionRef(path),
    runTransaction: <T>(fn: (tx: MemoryTx) => Promise<T>): Promise<T> => {
      const run = async () => {
        const writes: Array<() => void> = [];
        const tx: MemoryTx = {
          get: (target) => target.get(),
          set: (ref, data, opts) => {
            writes.push(() => writeSet(ref.path, data, opts?.merge === true));
            return tx;
          },
          update: (ref, patch) => {
            writes.push(() => writeUpdate(ref.path, patch));
            return tx;
          },
          create: (ref, data) => {
            writes.push(() => writeCreate(ref.path, data));
            return tx;
          },
          delete: (ref) => {
            writes.push(() => store.delete(ref.path));
            return tx;
          },
        };
        const result = await fn(tx);
        // All-or-nothing, like a real commit: validate every write against a
        // scratch copy first, so a failing create leaves nothing applied.
        const before = new Map(store);
        try {
          for (const w of writes) w();
        } catch (err) {
          store.clear();
          for (const [k, v] of before) store.set(k, v);
          throw err;
        }
        return result;
      };
      const next = txQueue.then(run, run);
      txQueue = next.catch(() => undefined);
      return next;
    },
  };

  return {
    db,
    /** Empty the store — call from beforeEach. */
    clear: () => store.clear(),
    /** Put a doc in place without going through the code under test. */
    seed: (path: string, data: Data) => store.set(path, structuredClone(data)),
    /** Current doc data, or undefined. */
    read: (path: string) => {
      const d = store.get(path);
      return d === undefined ? undefined : structuredClone(d);
    },
    /** Every doc directly under a collection path, as `{ id, ...data }`. */
    list: (collectionPath: string): Array<Data & { id: string }> =>
      [...store.entries()]
        .filter(([p]) => p.slice(0, p.lastIndexOf("/")) === collectionPath)
        .map(([p, d]) => ({ id: p.split("/").pop()!, ...structuredClone(d) })),
  };
}
