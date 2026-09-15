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
let messageDoc: Doc;
let claims: Record<string, unknown> | null;
/** Every object path the route asked the bucket for. Empty means it never
 *  reached Storage — which is what tests 2/3/6 assert. */
let fileCalls: string[];

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
        getMetadata: async () => [{ size: String(BYTES.length), contentType: "image/png" }],
        createReadStream: () => {
          async function* gen() {
            yield BYTES;
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
}));

vi.mock("firebase-admin/storage", () => ({
  getStorage: () => fakeStorage,
}));

import { GET } from "./route";

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
  claims = { status: "active", agencyId: AGENCY_ID, agencyRole: "staff" };
  contactDoc = { agencyId: AGENCY_ID, subAccountId: SUB_ACCOUNT_ID, name: "Ada" };
  memberDoc = { status: "active" };
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
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES);
  });

  it("sanitises a hostile document filename out of Content-Disposition", async () => {
    messageDoc = {
      ...(messageDoc as Record<string, unknown>),
      media: {
        kind: "document",
        mimeType: "application/pdf",
        filename: 'a"b\r\nX-Evil: 1.pdf',
        sizeBytes: BYTES.length,
        storagePath: EXPECTED_PATH,
      },
    };
    const res = await call(AUTHED);
    expect(res.status).toBe(200);
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toMatch(/^attachment/);
    expect(cd).not.toMatch(/[\r\n]/);
    // The only quotes allowed are the two around the ASCII fallback.
    expect(cd.replace(/filename="file"/, "")).not.toContain('"');
  });

  it("404s when the stored path disagrees with the derived one, without touching Storage", async () => {
    messageDoc = {
      ...(messageDoc as Record<string, unknown>),
      media: {
        kind: "image",
        mimeType: "image/png",
        filename: "photo.png",
        sizeBytes: BYTES.length,
        storagePath: "whatsapp-media/other-agency/other-sa/other-contact/other-msg",
      },
    };
    const res = await call(AUTHED);
    expect(res.status).toBe(404);
    expect(fileCalls).toEqual([]);
  });
});
