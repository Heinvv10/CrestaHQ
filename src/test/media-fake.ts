/**
 * Firestore + bucket fake for the Media Library service and route tests:
 * docs in a Map, objects in a Map. Enough query surface for
 * `lib/media/service.ts` (where ==, limit, doc/auto-id) and nothing more.
 */

export const BUCKET = "bkt";

export const mediaFake = {
  docs: new Map<string, Record<string, unknown>>(),
  objects: new Map<string, { size: string; contentType: string }>(),
  deletedObjects: [] as string[],
  /** Every doc path read — a malformed id must never reach Firestore. */
  reads: [] as string[],
};

export function resetMediaFake() {
  mediaFake.docs.clear();
  mediaFake.objects.clear();
  mediaFake.deletedObjects.length = 0;
  mediaFake.reads.length = 0;
}

let auto = 0;

function docRef(path: string) {
  const { docs } = mediaFake;
  return {
    id: path.split("/").pop()!,
    get: async () => {
      mediaFake.reads.push(path);
      return { exists: docs.has(path), data: () => docs.get(path) };
    },
    set: async (d: Record<string, unknown>) => void docs.set(path, { ...d }),
    update: async (d: Record<string, unknown>) => {
      if (!docs.has(path)) throw new Error("NOT_FOUND");
      docs.set(path, { ...docs.get(path)!, ...d });
    },
    delete: async () => void docs.delete(path),
  };
}

function query(path: string, filters: Array<[string, unknown]>) {
  return {
    where: (f: string, _op: string, v: unknown) => query(path, [...filters, [f, v]]),
    limit: () => query(path, filters),
    get: async () => {
      const docs = [...mediaFake.docs.entries()]
        .filter(([p]) => p.slice(0, p.lastIndexOf("/")) === path)
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v));
      return { empty: docs.length === 0, size: docs.length };
    },
    doc: (id?: string) => docRef(`${path}/${id ?? `auto_${++auto}`}`),
  };
}

function file(path: string) {
  const { objects, deletedObjects } = mediaFake;
  return {
    exists: async () => [objects.has(path)],
    getMetadata: async () => [objects.get(path) ?? {}],
    delete: async () => void (deletedObjects.push(path), objects.delete(path)),
  };
}

export const mediaAdminMock = () => ({
  getAdminDb: () => ({ doc: docRef, collection: (p: string) => query(p, []) }),
  getAdminStorage: () => ({ bucket: () => ({ name: BUCKET, file }) }),
});

/** A Firebase token download URL for `path` in `bucket`. */
export const downloadUrl = (path: string, bucket = BUCKET) =>
  `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=t`;
