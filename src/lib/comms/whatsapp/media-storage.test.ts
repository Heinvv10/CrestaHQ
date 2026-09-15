import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `putWhatsappMedia` has no caller yet — the inbound rails (A1b, A2) and the
 * outbound composer (B1) call it next. It is tested now anyway: it is the
 * writer into a bucket that will hold customers' photos and voice notes, and
 * "inert until something calls it" is not a reason to ship a writer whose
 * failure branches have never run.
 */

const BUCKET_ENV = "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET";

interface SaveCall {
  path: string;
  bytes: Buffer;
  opts: Record<string, unknown>;
}

let saveCalls: SaveCall[];
let saveThrows: Error | null;
let bucketNames: string[];
/** What was passed to getStorage — proving the app is explicit, not the default. */
let storageApps: unknown[];

const fakeStorage = {
  bucket: (name: string) => {
    bucketNames.push(name);
    return {
      file: (path: string) => ({
        save: async (bytes: Buffer, opts: Record<string, unknown>) => {
          if (saveThrows) throw saveThrows;
          saveCalls.push({ path, bytes, opts });
        },
      }),
    };
  },
};

vi.mock("firebase-admin/storage", () => ({
  getStorage: (app?: unknown) => {
    storageApps.push(app);
    return fakeStorage;
  },
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminApp: () => ({ name: "test-app" }),
}));

import {
  putWhatsappMedia,
  whatsappMediaPath,
} from "@/lib/comms/whatsapp/media-storage";

const ORIGINAL_BUCKET = process.env[BUCKET_ENV];

beforeEach(() => {
  saveCalls = [];
  bucketNames = [];
  storageApps = [];
  saveThrows = null;
  process.env[BUCKET_ENV] = "test-bucket.appspot.com";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_BUCKET === undefined) delete process.env[BUCKET_ENV];
  else process.env[BUCKET_ENV] = ORIGINAL_BUCKET;
  vi.restoreAllMocks();
});

describe("whatsappMediaPath", () => {
  it("carries no filename segment", () => {
    // The filename lives on the doc precisely so a hostile or non-ASCII name
    // never reaches a bucket path.
    const path = whatsappMediaPath({
      agencyId: "a1",
      subAccountId: "sa1",
      contactId: "c1",
      messageDocId: "m1",
    });
    expect(path).toBe("whatsapp-media/a1/sa1/c1/m1");
  });
});

describe("putWhatsappMedia", () => {
  it("writes the bytes WITHOUT a public download token", async () => {
    const res = await putWhatsappMedia({
      path: "whatsapp-media/a1/sa1/c1/m1",
      bytes: Buffer.from("hello"),
      contentType: "image/png",
    });
    expect(res).toEqual({ ok: true });
    expect(bucketNames).toEqual(["test-bucket.appspot.com"]);
    // Explicit app, not the default one: a webhook can reach Storage before
    // anything has initialised the default app, and getStorage() would then
    // throw "The default Firebase app does not exist".
    expect(storageApps).toEqual([{ name: "test-app" }]);
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]!.bytes).toEqual(Buffer.from("hello"));
    // A firebaseStorageDownloadTokens entry is a permanent unauthenticated
    // public URL. These are customers' photos and voice notes (POPIA), so the
    // metadata must carry nothing but the content type.
    expect(saveCalls[0]!.opts).toEqual({
      resumable: false,
      metadata: { contentType: "image/png" },
    });
    expect(JSON.stringify(saveCalls[0]!.opts)).not.toContain(
      "firebaseStorageDownloadTokens",
    );
  });

  it("reports bucket_unconfigured, and writes nothing, when the env var is unset", async () => {
    delete process.env[BUCKET_ENV];
    const res = await putWhatsappMedia({
      path: "whatsapp-media/a1/sa1/c1/m1",
      bytes: Buffer.from("hello"),
      contentType: "image/png",
    });
    expect(res).toEqual({ ok: false, reason: "bucket_unconfigured" });
    expect(bucketNames).toEqual([]);
    expect(saveCalls).toEqual([]);
  });

  it("reports store_failed instead of throwing when the bucket write fails", async () => {
    // The caller writes a text-only row with mediaDropped on this branch, so it
    // must come back as a value — a throw here would lose the whole message.
    saveThrows = new Error("bucket exploded");
    const res = await putWhatsappMedia({
      path: "whatsapp-media/a1/sa1/c1/m1",
      bytes: Buffer.from("hello"),
      contentType: "image/png",
    });
    expect(res).toEqual({ ok: false, reason: "store_failed" });
    expect(saveCalls).toEqual([]);
  });
});
