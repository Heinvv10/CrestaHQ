import { Readable } from "node:stream";

/**
 * In-memory bucket for the WhatsApp send route's staged-attachment tests.
 * Objects carry a generation so a read pinned to one can be told apart from
 * a replaced object, and every Storage call is logged in order.
 *
 * No app imports: `vi.mock("firebase-admin/storage")` loads this.
 *
 *   vi.mock("firebase-admin/storage", async () =>
 *     (await import("@/test/staged-bucket")).storageMock());
 */

export interface StoredObject {
  bytes: Buffer;
  contentType: string;
  generation: number;
  /** Metadata size when it should differ from the bytes (a huge object never materialised). */
  size?: number;
}

export const bucketFake = {
  objects: new Map<string, StoredObject>(),
  log: [] as string[],
  copyThrows: null as Error | null,
  getStorageThrows: null as Error | null,
};

export function resetBucketFake() {
  bucketFake.objects = new Map();
  bucketFake.log = [];
  bucketFake.copyThrows = null;
  bucketFake.getStorageThrows = null;
}

export function stageObject(
  path: string,
  bytes: Buffer,
  contentType: string,
  extra: Partial<StoredObject> = {},
) {
  bucketFake.objects.set(path, { bytes, contentType, generation: 7, ...extra });
}

function file(path: string, opts: { generation?: number } = {}) {
  const { log } = bucketFake;
  const live = () => {
    const o = bucketFake.objects.get(path);
    if (!o || (opts.generation !== undefined && o.generation !== opts.generation)) {
      throw Object.assign(new Error("No such object"), { code: 404 });
    }
    return o;
  };
  return {
    name: path,
    getMetadata: async () => {
      log.push(`stat ${path}`);
      const o = live();
      return [{ size: String(o.size ?? o.bytes.length), contentType: o.contentType, generation: String(o.generation) }];
    },
    createReadStream: () => {
      log.push(`read ${path}@${opts.generation}`);
      const o = live();
      const chunks: Buffer[] = [];
      for (let i = 0; i < o.bytes.length; i += 1 << 20) chunks.push(o.bytes.subarray(i, i + (1 << 20)));
      return Readable.from(chunks);
    },
    copy: async (dest: { name: string }) => {
      log.push(`copy ${path}@${opts.generation} -> ${dest.name}`);
      if (bucketFake.copyThrows) throw bucketFake.copyThrows;
      bucketFake.objects.set(dest.name, { ...live() });
    },
    delete: async () => {
      log.push(`delete ${path}`);
      bucketFake.objects.delete(path);
    },
    save: async (bytes: Buffer, o?: { metadata?: { contentType?: string } }) => {
      log.push(`save ${path}`);
      bucketFake.objects.set(path, { bytes: Buffer.from(bytes), contentType: o?.metadata?.contentType ?? "", generation: 1 });
    },
  };
}

export function storageMock() {
  return {
    getStorage: () => {
      if (bucketFake.getStorageThrows) throw bucketFake.getStorageThrows;
      return { bucket: () => ({ file }) };
    },
  };
}
