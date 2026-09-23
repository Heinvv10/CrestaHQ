import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Seam tests for the WhatsApp media serving route. These go through the route
 * HANDLER, not a helper beside it — the repo's known failure mode is a test
 * that covers a pure function while the wiring around it is wrong
 * (`feedback_test_the_seam_not_the_helper`).
 *
 * Deliberately NOT mocked: `@/lib/comms/route-auth`. The 401/403 cases only
 * mean something if the real `requireUid` + `requireContactAccessible` run, so
 * the fakes sit one layer lower — at `getAdminDb` / `getAdminAuth` / `getStorage`.
 */

process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = "test-bucket.appspot.com";

const AGENCY_ID = "agency-1";
const SUB_ACCOUNT_ID = "sa-1";
const CONTACT_ID = "contact-1";
const MESSAGE_ID = "wamid-1";
const EXPECTED_PATH = `whatsapp-media/${AGENCY_ID}/${SUB_ACCOUNT_ID}/${CONTACT_ID}/${MESSAGE_ID}`;

// ── Fakes ─────────────────────────────────────────────────────────────────
type Doc = Record<string, unknown> | null;

let contactDoc: Doc;
let memberDoc: Doc;
/** The sub-account row — only read for a collaborator's territory check. */
let subAccountDoc: Doc;
let messageDoc: Doc;
let claims: Record<string, unknown> | null;
/** Every object path the route asked the bucket for. Empty means it never
 *  reached Storage — which is what the refusal tests assert. */
let fileCalls: string[];
/** Options handed to createReadStream, so a range can be proven to reach the bucket. */
let readCalls: ({ start: number; end: number } | undefined)[];
/** When set, `getStorage` throws synchronously — an admin app or Storage init failure. */
let storageInitError: Error | null;
/** When set, `getMetadata` rejects with it — how a missing object surfaces. */
let metadataError: Error | null;

const BYTES = Buffer.from("PNGDATA-not-a-real-image");

const snap = (data: Doc, id: string) => ({
  exists: data !== null,
  id,
  data: () => data ?? undefined,
});

const fakeDb = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => {
        if (name === "contacts") return snap(contactDoc, id);
        throw new Error(`unexpected collection ${name}`);
      },
    }),
  }),
  doc: (path: string) => ({
    get: async () => {
      if (path.includes("/subAccountMembers/")) return snap(memberDoc, path);
      if (path === `subAccounts/${SUB_ACCOUNT_ID}`) return snap(subAccountDoc, path);
      if (path.includes("/whatsappMessages/")) return snap(messageDoc, path);
      throw new Error(`unexpected doc path ${path}`);
    },
  }),
};

const fakeAuth = {
  getUser: async () => ({ customClaims: claims ?? {} }),
};

const fakeStorage = {
  bucket: () => ({
    file: (path: string) => {
      fileCalls.push(path);
      return {
        getMetadata: async () => {
          if (metadataError) throw metadataError;
          return [{ size: String(BYTES.length), contentType: "image/png" }];
        },
        createReadStream: (opts?: { start: number; end: number }) => {
          readCalls.push(opts);
          const slice = opts ? BYTES.subarray(opts.start, opts.end + 1) : BYTES;
          async function* gen() {
            yield slice;
          }
          return gen();
        },
      };
    },
  }),
};

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => fakeDb,
  getAdminAuth: () => fakeAuth,
  getAdminApp: () => ({ name: "test-app" }),
}));

vi.mock("firebase-admin/storage", () => ({
  getStorage: () => {
    if (storageInitError) throw storageInitError;
    return fakeStorage;
  },
}));

import { GET } from "./route";

/** Swap the `media` value on the fixture row, leaving its tenancy keys alone. */
function withMedia(media: Record<string, unknown> | null) {
  messageDoc = { ...(messageDoc as Record<string, unknown>), media };
}

function call(headers: Record<string, string> = {}) {
  return GET(
    new Request(
      `http://localhost/api/comms/whatsapp/media/${CONTACT_ID}/${MESSAGE_ID}`,
      { headers },
    ),
    { params: Promise.resolve({ contactId: CONTACT_ID, messageId: MESSAGE_ID }) },
  );
}

const AUTHED = { "x-user-uid": "user-1" };

beforeEach(() => {
  fileCalls = [];
  readCalls = [];
  storageInitError = null;
  metadataError = null;
  vi.restoreAllMocks();
  claims = { status: "active", agencyId: AGENCY_ID, agencyRole: "staff" };
  contactDoc = { agencyId: AGENCY_ID, subAccountId: SUB_ACCOUNT_ID, name: "Ada" };
  memberDoc = { status: "active" };
  subAccountDoc = null;
  messageDoc = {
    agencyId: AGENCY_ID,
    subAccountId: SUB_ACCOUNT_ID,
    contactId: CONTACT_ID,
    direction: "inbound",
    body: "look at this",
    media: {
      kind: "image",
      mimeType: "image/png",
      filename: "photo.png",
      sizeBytes: BYTES.length,
      storagePath: EXPECTED_PATH,
    },
  };
});

describe("GET /api/comms/whatsapp/media/[contactId]/[messageId]", () => {
  it("401s without an authenticated uid", async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(fileCalls).toEqual([]);
  });

  it("403s for a user with no membership in the contact's sub-account", async () => {
    memberDoc = null;
    const res = await call(AUTHED);
    expect(res.status).toBe(403);
    expect(fileCalls).toEqual([]);
  });

  it("403s a territory-scoped collaborator for a contact outside their territories", async () => {
    subAccountDoc = { territoryScopingEnabled: true };
    memberDoc = { status: "active", role: "collaborator", assignedTerritoryIds: ["t1"] };
    contactDoc = { ...(contactDoc as Record<string, unknown>), territoryId: "t2" };
    const res = await call(AUTHED);
    expect(res.status).toBe(403);
    expect(fileCalls).toEqual([]);
  });

  it("serves a territory-scoped collaborator a contact in their territory", async () => {
    subAccountDoc = { territoryScopingEnabled: true };
    memberDoc = { status: "active", role: "collaborator", assignedTerritoryIds: ["t1"] };
    contactDoc = { ...(contactDoc as Record<string, unknown>), territoryId: "t1" };
    const res = await call(AUTHED);
    expect(res.status).toBe(200);
    expect(fileCalls).toEqual([EXPECTED_PATH]);
  });

  it("404s when the message row carries no media", async () => {
    messageDoc = {
      agencyId: AGENCY_ID,
      subAccountId: SUB_ACCOUNT_ID,
      contactId: CONTACT_ID,
      body: "just text",
    };
    const res = await call(AUTHED);
    expect(res.status).toBe(404);
    expect(fileCalls).toEqual([]);
  });

  it("serves the object with the doc's mime type, inline, for an image", async () => {
    const res = await call(AUTHED);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/^inline/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(fileCalls).toEqual([EXPECTED_PATH]);
    expect(readCalls).toEqual([undefined]);
    // No Content-Length on a full response: the size came from metadata and the
    // bytes from a separate stream, so the header could disagree with the body.
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES);
  });

  it("serves an unrecognised mime as an opaque download, not as its own type", async () => {
    // There is no CSP on this route (next.config.ts sets one only on
    // /embed/:path*), so this plus nosniff is the whole defence against a row
    // written with text/html rendering in the operator's own origin.
    withMedia({
      kind: "document",
      mimeType: "text/html",
      filename: "payload.html",
      sizeBytes: BYTES.length,
      storagePath: EXPECTED_PATH,
    });
    const res = await call(AUTHED);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("404s on a partially written media map instead of throwing a 500", async () => {
    // Exactly what a half-finished write from an inbound rail produces.
    withMedia({ storagePath: EXPECTED_PATH });
    const res = await call(AUTHED);
    expect(res.status).toBe(404);
    expect(fileCalls).toEqual([]);
  });

  it("does not 500 on a filename carrying a lone surrogate", async () => {
    withMedia({
      kind: "document",
      mimeType: "application/pdf",
      filename: "broken-\uD800-name.pdf",
      sizeBytes: BYTES.length,
      storagePath: EXPECTED_PATH,
    });
    const res = await call(AUTHED);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  it("404s when the row's tenancy keys disagree with the contact's", async () => {
    // The storagePath is made to AGREE with the row's own (wrong) tenancy, so
    // the path re-derivation below is satisfied and only the row-vs-contact
    // comparison can catch this. Without that, the test would pass on the path
    // check alone and prove nothing.
    messageDoc = {
      ...(messageDoc as Record<string, unknown>),
      subAccountId: "sa-someone-else",
      media: {
        kind: "image",
        mimeType: "image/png",
        filename: "photo.png",
        sizeBytes: BYTES.length,
        storagePath: `whatsapp-media/${AGENCY_ID}/sa-someone-else/${CONTACT_ID}/${MESSAGE_ID}`,
      },
    };
    const res = await call(AUTHED);
    expect(res.status).toBe(404);
    expect(fileCalls).toEqual([]);
  });

  it("serves a byte range as 206, reading only those bytes from the bucket", async () => {
    const res = await call({ ...AUTHED, range: "bytes=2-5" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 2-5/${BYTES.length}`);
    // Derived from the same range handed to the reader, so header and body
    // cannot disagree.
    expect(res.headers.get("content-length")).toBe("4");
    expect(readCalls).toEqual([{ start: 2, end: 5 }]);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES.subarray(2, 6));
  });

  it("clamps a range whose end runs past the object, so Content-Length matches the body", async () => {
    // Without the clamp this would send `bytes 0-99999/24`, Content-Length
    // 100000 and a 24-byte body — the header/body disagreement this route
    // claims cannot happen.
    const res = await call({ ...AUTHED, range: "bytes=0-99999" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(
      `bytes 0-${BYTES.length - 1}/${BYTES.length}`,
    );
    expect(res.headers.get("content-length")).toBe(String(BYTES.length));
    expect(readCalls).toEqual([{ start: 0, end: BYTES.length - 1 }]);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES);
  });

  it("passes a voice note's parameterised mime type through untouched", async () => {
    // WhatsApp voice notes arrive as `audio/ogg; codecs=opus`. The allow-list
    // must match on the bare type, or every voice note is served as an opaque
    // download and the audio element will not play.
    withMedia({
      kind: "audio",
      mimeType: "audio/ogg; codecs=opus",
      filename: "voice-note.ogg",
      sizeBytes: BYTES.length,
      storagePath: EXPECTED_PATH,
    });
    const res = await call(AUTHED);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/ogg; codecs=opus");
    expect(res.headers.get("content-disposition")).toMatch(/^inline/);
  });

  it("416s on a range that starts past the end of the object", async () => {
    const res = await call({ ...AUTHED, range: `bytes=${BYTES.length + 10}-` });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${BYTES.length}`);
    expect(readCalls).toEqual([]);
  });

  it("sanitises a hostile document filename out of Content-Disposition", async () => {
    withMedia({
      kind: "document",
      mimeType: "application/pdf",
      filename: 'a"b\r\nX-Evil: 1.pdf',
      sizeBytes: BYTES.length,
      storagePath: EXPECTED_PATH,
    });
    const res = await call(AUTHED);
    expect(res.status).toBe(200);
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toMatch(/^attachment/);
    expect(cd).not.toMatch(/[\r\n]/);
    // The only quotes allowed are the two around the ASCII fallback.
    expect(cd.replace(/filename="file"/, "")).not.toContain('"');
  });

  it("percent-encodes the characters encodeURIComponent leaves as non-attr-char", async () => {
    // `! * ( )` survive encodeURIComponent but are not RFC 5987 attr-char, so a
    // strict parser may discard the whole filename* parameter.
    withMedia({
      kind: "document",
      mimeType: "application/pdf",
      filename: "re(port)*!.pdf",
      sizeBytes: BYTES.length,
      storagePath: EXPECTED_PATH,
    });
    const res = await call(AUTHED);
    const star = (res.headers.get("content-disposition") ?? "").split(
      "filename*=UTF-8''",
    )[1];
    expect(star).toBe("re%28port%29%2A%21.pdf");
  });

  it("404s instead of 500 when resolving the bucket throws synchronously", async () => {
    // The row and the caller are both valid, so only the Storage init failure
    // stands between this request and a 200. It must end in the route's own
    // not-found answer, not an unhandled throw.
    storageInitError = new Error("The default Firebase app does not exist");
    const res = await call(AUTHED);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(fileCalls).toEqual([]);
  });

  it("404s silently when the object is missing — a normal state, not an error", async () => {
    // A deleted object, or an upload that failed after the row was written.
    // Logging every such request would bury the init failures the log exists
    // to catch.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    metadataError = Object.assign(new Error("No such object"), { code: 404 });
    const res = await call(AUTHED);
    expect(res.status).toBe(404);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("logs an init failure once, without the request's bearer token", async () => {
    // A Storage ApiError carries `response.request.headers`, Authorization
    // included. The log must carry the code and message, never the raw error.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    storageInitError = Object.assign(new Error("init failed"), {
      code: 500,
      response: {
        request: { headers: { Authorization: "Bearer ya29.secret-token" } },
      },
    });
    const res = await call(AUTHED);
    expect(res.status).toBe(404);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain("init failed");
    expect(logged).not.toContain("Authorization");
    expect(logged).not.toContain("secret-token");
  });

  it("404s when the stored path disagrees with the derived one, without touching Storage", async () => {
    withMedia({
      kind: "image",
      mimeType: "image/png",
      filename: "photo.png",
      sizeBytes: BYTES.length,
      storagePath: "whatsapp-media/other-agency/other-sa/other-contact/other-msg",
    });
    const res = await call(AUTHED);
    expect(res.status).toBe(404);
    expect(fileCalls).toEqual([]);
  });
});
