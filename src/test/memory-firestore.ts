import { FieldValue } from "firebase-admin/firestore";

/**
 * In-memory Firestore for seam tests (route → real service → real engine).
 * Unlike the suite's ad-hoc fakes it honours `where` — otherwise the wrong
 * query finds the right doc — applies FieldValue transforms, and yields
 * between operations so concurrent requests interleave. Transactions commit
 * atomically and re-run if any doc they read changed, as Firestore retries on
 * contention; queries get NO phantom protection, so code relying on a query
 * alone to prevent a duplicate races here. Add an operator when a test needs
 * it, not before. */

type Data = Record<string, unknown>;
type WhereOp = "==" | "!=" | "in" | "array-contains" | ">=" | "<=" | "<";

const DELETE = Symbol("delete");
/** Order key standing in for FieldPath.documentId(). */
const ID_ORDER = "__name__";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const transformOf = (v: unknown): string | null =>
  v instanceof FieldValue ? (v as unknown as { methodName: string }).methodName : null;

const isTs = (v: unknown): v is { toMillis: () => number } => typeof (v as { toMillis?: unknown })?.toMillis === "function";

/** Maps only — a Timestamp, Date or FieldValue is a VALUE, as in Firestore. */
function isPlainObject(v: unknown): v is Data {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Deep-copies maps/arrays; keeps class instances (structuredClone strips `toDate`). */
function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as T;
  if (!isPlainObject(v)) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
}

function resolveValue(current: unknown, v: unknown): unknown {
  const t = transformOf(v);
  // Copy, as Firestore serializes at call time: a caller mutating its array
  // after set() must not reach into the stored doc.
  if (t === null) return Array.isArray(v) ? clone(v) : v;
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
  // The app's Admin SDK runs with `ignoreUndefinedProperties` (admin.ts):
  // an undefined field is skipped, not written.
  if (value === undefined) return;
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
    case "!=": // Firestore: a missing field never matches an inequality
      return actual !== undefined && actual !== value;
    case ">=":
    case "<=":
    case "<": {
      // Range filters compare instants: Date and Timestamp are one type here,
      // as in Firestore. A missing field never matches.
      const ms = (v: unknown) =>
        v instanceof Date ? v.getTime() : isTs(v) ? v.toMillis() : v;
      const [a, b] = [ms(actual), ms(value)];
      if (a === undefined || typeof a !== typeof b) return false;
      if (op === "<") return (a as number) < (b as number);
      return op === ">=" ? (a as number) >= (b as number) : (a as number) <= (b as number);
    }
  }
}

export interface MemoryDocSnapshot {
  id: string;
  exists: boolean;
  /** Write count at read time; a transaction's conflict check compares it. */
  version: number;
  ref: MemoryDocRef;
  data: () => Data | undefined;
}

type Write<A extends unknown[]> = (...args: A) => Promise<void>;
export interface MemoryDocRef {
  id: string;
  path: string;
  get: () => Promise<MemoryDocSnapshot>;
  set: Write<[Data, { merge?: boolean }?]>;
  update: Write<[Data]>;
  create: Write<[Data]>;
  delete: Write<[]>;
  collection: (name: string) => MemoryQuery & {
    doc: (id?: string) => MemoryDocRef;
    add: (data: Data) => Promise<MemoryDocRef>;
  };
}

export interface MemoryQuery {
  /** A non-string field (FieldPath.documentId()) filters on the document id. */
  where: (field: string | object, op: WhereOp, value: unknown) => MemoryQuery;
  /** A non-string field (FieldPath.documentId()) orders by document id. */
  orderBy: (field: string | object, dir?: "asc" | "desc") => MemoryQuery;
  limit: (n: number) => MemoryQuery;
  /** Continue after this document/cursor in the query's order. A string is
   *  the value overload for a single document-id order field. Multiple
   *  args are the value overload for a compound orderBy, one per field. */
  startAfter: (...args: [MemoryDocSnapshot | string] | unknown[]) => MemoryQuery;
  /** Projection is ignored — full docs come back, which is a superset. */
  select: (...fields: string[]) => MemoryQuery;
  get: () => Promise<{ empty: boolean; size: number; docs: MemoryDocSnapshot[] }>;
  /** Aggregate count — same filters, one number instead of the docs. */
  count: () => { get: () => Promise<{ data: () => { count: number } }> };
}

type TxWrite = (ref: MemoryDocRef, data: Data, opts?: { merge?: boolean }) => MemoryTx;
interface MemoryTx extends Record<"set" | "update" | "create", TxWrite> {
  get: (target: MemoryDocRef | MemoryQuery) => Promise<unknown>;
  getAll: (...refs: MemoryDocRef[]) => Promise<MemoryDocSnapshot[]>;
  delete: (ref: MemoryDocRef) => MemoryTx;
}

export function createMemoryFirestore() {
  const store = new Map<string, Data>();
  let autoId = 0;
  const versions = new Map<string, number>();
  const bump = (path: string) => versions.set(path, (versions.get(path) ?? 0) + 1);
  const remove = (path: string) => void (store.delete(path), bump(path));

  const snapshot = (path: string): MemoryDocSnapshot => {
    const data = store.get(path);
    return {
      id: path.split("/").pop()!,
      exists: data !== undefined,
      version: versions.get(path) ?? 0,
      ref: docRef(path),
      data: () => (data === undefined ? undefined : clone(data)),
    };
  };

  const writeSet = (path: string, data: Data, merge: boolean) => {
    const next = merge ? clone(store.get(path) ?? {}) : {};
    mergeInto(next, data);
    store.set(path, next);
    bump(path);
  };

  const writeUpdate = (path: string, patch: Data) => {
    const current = store.get(path);
    if (current === undefined) {
      throw Object.assign(new Error(`5 NOT_FOUND: No document to update: ${path}`), {
        code: 5,
      });
    }
    const next = clone(current);
    for (const [k, v] of Object.entries(patch)) setPath(next, k.split("."), v);
    store.set(path, next);
    bump(path);
  };

  const writeCreate = (path: string, data: Data) => {
    if (store.has(path)) throw Object.assign(new Error(`6 ALREADY_EXISTS: ${path}`), { code: 6 });
    writeSet(path, data, false);
  };

  function docRef(path: string): MemoryDocRef {
    return {
      id: path.split("/").pop()!,
      path,
      get: () => { const snap = snapshot(path); return tick().then(() => snap); },
      set: (data, opts) => tick().then(() => writeSet(path, data, opts?.merge === true)),
      update: (patch) => tick().then(() => writeUpdate(path, patch)),
      create: (data) => tick().then(() => writeCreate(path, data)),
      delete: () => tick().then(() => remove(path)),
      collection: (name) => collectionRef(`${path}/${name}`),
    };
  }

  /** `inScope` picks the docs by parent collection path — one path, or a group. */
  function query(
    inScope: (parentPath: string) => boolean,
    filters: Array<[string, WhereOp, unknown]>,
    order: Array<[string, "asc" | "desc"]>,
    max: number | null,
    // A doc snapshot cursor (plain path string) is position-based. A value
    // cursor is one value per orderBy field, in order — as Firestore's
    // startAfter(...fieldValues) does; `{ id }` is its single-field,
    // document-id-order special case (the string overload).
    after: string | { id: string } | unknown[] | null = null,
  ): MemoryQuery {
    return {
      where: (f, op, v) =>
        query(inScope, [...filters, [typeof f === "string" ? f : ID_ORDER, op, v]], order, max, after),
      orderBy: (f, dir = "asc") =>
        query(inScope, filters, [...order, [typeof f === "string" ? f : ID_ORDER, dir]], max, after),
      limit: (n) => query(inScope, filters, order, n, after),
      startAfter: (...args) =>
        query(
          inScope,
          filters,
          order,
          max,
          args.length === 1 && typeof args[0] === "object" && args[0] !== null && "ref" in (args[0] as object)
            ? (args[0] as MemoryDocSnapshot).ref.path
            : args.length === 1 && typeof args[0] === "string"
              ? { id: args[0] }
              : args,
        ),
      select: () => query(inScope, filters, order, max, after),
      // Reads observe the store when ISSUED and resolve a tick later, so two
      // concurrent transactions can both read before either commits.
      get: () => {
        let paths = [...store.keys()].filter((p) => {
          if (!inScope(p.slice(0, p.lastIndexOf("/")))) return false;
          const data = store.get(p)!;
          return filters.every(([f, op, v]) =>
            f === ID_ORDER ? matches({ [ID_ORDER]: p.split("/").pop() }, f, op, v) : matches(data, f, op, v)
          );
        });
        const normalize = (v: unknown): number | string =>
          v instanceof Date ? v.getTime() : isTs(v) ? v.toMillis() : (v as number | string);
        const keyOf = (f: string, p: string): number | string =>
          normalize(f === ID_ORDER ? p.split("/").pop() : getPath(store.get(p)!, f));
        if (order.length > 0) {
          paths.sort((a, b) => {
            for (const [f, dir] of order) {
              const [ka, kb] = [keyOf(f, a), keyOf(f, b)];
              if (ka === kb) continue;
              const cmp = ka < kb ? -1 : 1;
              return dir === "desc" ? -cmp : cmp;
            }
            return 0;
          });
        }
        // By position: rows up to and including the cursor doc are skipped. Unlike
        // Firestore, the cursor doc must itself be in this query's result — a
        // cursor that is not throws rather than silently returning every row.
        if (Array.isArray(after)) {
          if (after.length !== order.length) return Promise.reject(new Error("memory-firestore: startAfter must supply one value per orderBy field"));
          paths = paths.filter((p) => {
            for (let i = 0; i < order.length; i += 1) {
              const [f, dir] = order[i]!;
              const [pk, ak] = [keyOf(f, p), normalize(after[i])];
              if (pk === ak) continue;
              return dir === "desc" ? pk < ak : pk > ak;
            }
            return false;
          });
        } else if (after !== null && typeof after === "object") {
          if (order[0]?.[0] !== ID_ORDER) return Promise.reject(new Error("memory-firestore: a value cursor needs document-id order"));
          paths = paths.filter((p) => p.split("/").pop()! > after.id);
        } else if (after !== null) {
          const at = paths.indexOf(after);
          if (at === -1) return Promise.reject(new Error(`memory-firestore: startAfter cursor ${after} is not in the query's result`));
          paths = paths.slice(at + 1);
        }
        if (max !== null) paths = paths.slice(0, max);
        const docs = paths.map(snapshot);
        return tick().then(() => ({ empty: docs.length === 0, size: docs.length, docs }));
      },
      count: () => ({
        get: () => query(inScope, filters, order, max, after).get().then((r) => ({ data: () => ({ count: r.size }) })),
      }),
    };
  }

  function collectionRef(path: string) {
    const doc = (id?: string) => docRef(`${path}/${id ?? `auto${++autoId}`}`);
    return Object.assign(query((parent) => parent === path, [], [], null), {
      doc,
      add: async (data: Data) => {
        const ref = doc();
        await ref.set(data);
        return ref;
      },
    });
  }

  /** All-or-nothing: a failing write (e.g. create on an existing doc) leaves nothing applied. */
  const applyAll = (writes: Array<() => void>) => {
    const [before, beforeVersions] = [new Map(store), new Map(versions)];
    try {
      for (const w of writes) w();
    } catch (err) {
      store.clear();
      versions.clear();
      for (const [k, v] of before) store.set(k, v);
      for (const [k, v] of beforeVersions) versions.set(k, v);
      throw err;
    }
  };

  const db = {
    doc: (path: string) => docRef(path),
    getAll: (...refs: MemoryDocRef[]) => Promise.all(refs.map((r) => r.get())),
    batch: () => {
      const writes: Array<() => void> = [];
      const queue = (w: () => void) => (writes.push(w), b);
      const b = {
        set: (ref: MemoryDocRef, data: Data, opts?: { merge?: boolean }) =>
          queue(() => writeSet(ref.path, data, opts?.merge === true)),
        update: (ref: MemoryDocRef, patch: Data) => queue(() => writeUpdate(ref.path, patch)),
        create: (ref: MemoryDocRef, data: Data) => queue(() => writeCreate(ref.path, data)),
        delete: (ref: MemoryDocRef) => queue(() => remove(ref.path)),
        commit: () => tick().then(() => applyAll(writes)),
      };
      return b;
    },
    collection: (path: string) => collectionRef(path),
    collectionGroup: (name: string) =>
      query((parent) => parent.split("/").pop() === name, [], [], null),
    runTransaction: async <T>(fn: (tx: MemoryTx) => Promise<T>): Promise<T> => {
      for (let attempt = 1; ; attempt++) {
        const reads = new Map<string, number>();
        const writes: Array<() => void> = [];
        const note = (snap: MemoryDocSnapshot) => reads.set(snap.ref.path, snap.version);
        const queue = (w: () => void) => (writes.push(w), tx);
        const tx: MemoryTx = {
          get: async (target) => {
            const r = (await target.get()) as MemoryDocSnapshot | { docs: MemoryDocSnapshot[] };
            if ("docs" in r) r.docs.forEach(note);
            else note(r);
            return r;
          },
          getAll: async (...refs) => {
            const snaps = await Promise.all(refs.map((r) => r.get()));
            snaps.forEach(note);
            return snaps;
          },
          set: (ref, data, opts) => queue(() => writeSet(ref.path, data, opts?.merge === true)),
          update: (ref, patch) => queue(() => writeUpdate(ref.path, patch)),
          create: (ref, data) => queue(() => writeCreate(ref.path, data)),
          delete: (ref) => queue(() => remove(ref.path)),
        };
        const result = await fn(tx);
        // Synchronous from here to the return, so nothing interleaves
        // between the conflict check and the apply.
        if ([...reads].some(([p, v]) => (versions.get(p) ?? 0) !== v)) {
          if (attempt < 5) continue;
          throw Object.assign(new Error("10 ABORTED: contention"), { code: 10 });
        }
        applyAll(writes);
        return result;
      }
    },
  };

  return {
    db,
    /** Empty the store — call from beforeEach. */
    clear: () => (store.clear(), versions.clear()),
    /** Put a doc in place without going through the code under test. */
    seed: (path: string, data: Data) => void (store.set(path, clone(data)), bump(path)),
    /** Current doc data, or undefined. */
    read: (path: string) => {
      const d = store.get(path);
      return d === undefined ? undefined : clone(d);
    },
    /** Every doc directly under a collection path, as `{ id, ...data }`. */
    list: (path: string): Array<Data & { id: string }> =>
      [...store.entries()].filter(([p]) => p.slice(0, p.lastIndexOf("/")) === path)
        .map(([p, d]) => ({ id: p.split("/").pop()!, ...clone(d) })),
  };
}
