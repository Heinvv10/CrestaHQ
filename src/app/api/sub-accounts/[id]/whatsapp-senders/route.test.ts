import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppSender } from "@/types/whatsapp-senders";

/**
 * The sender-registry routes, driven for real — the tenancy guard included.
 *
 * The invariant worth a test is the default: two senders flagged `isDefault`
 * means a step with no `senderId` picks by array order, so it changes number
 * whenever the array is rewritten. The client cannot be trusted to keep that
 * to one, so the enforcement is asserted at the route, not at the helper.
 */

const SUB = "sa_1";

let docs: Map<string, Record<string, unknown>>;
let writes: Array<Record<string, unknown>>;
/** Bumped on every committed write — the fake's version of a Firestore
 *  update time, which is what a transaction checks before committing. */
let version: number;
/** Runs ONCE inside the next transaction, between its read and its commit.
 *  This is how a concurrent writer is interleaved deterministically. */
let betweenReadAndCommit: (() => Promise<void>) | null;

interface FakeRef {
  path: string;
  get: () => Promise<{ exists: boolean; data: () => unknown; id: string }>;
  set: (data: Record<string, unknown>) => Promise<void>;
}

function docRef(path: string): FakeRef {
  return {
    path,
    get: async () => ({
      exists: docs.has(path),
      data: () => docs.get(path),
      id: path.split("/").pop() as string,
    }),
    set: async (data: Record<string, unknown>) => {
      writes.push(data);
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
      version += 1;
    },
  };
}

/**
 * A transaction with the one property that matters here: a commit is refused,
 * and the body re-run, when a document it READ was written by someone else in
 * the meantime. Without that, this fake would pass a read-then-write route
 * that Firestore itself would not protect.
 */
async function runTransaction<T>(
  fn: (tx: {
    get: (ref: FakeRef) => Promise<{ exists: boolean; data: () => unknown }>;
    set: (ref: FakeRef, data: Record<string, unknown>) => void;
  }) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const readAt = new Map<string, number>();
    const pending: Array<[FakeRef, Record<string, unknown>]> = [];
    const result = await fn({
      get: async (ref) => {
        readAt.set(ref.path, version);
        const snap = await ref.get();
        if (betweenReadAndCommit) {
          const hook = betweenReadAndCommit;
          betweenReadAndCommit = null;
          await hook();
        }
        return snap;
      },
      set: (ref, data) => pending.push([ref, data]),
    });
    if ([...readAt].some(([path, v]) => v !== version && docs.has(path))) {
      continue; // contended — re-run against the newer document
    }
    for (const [ref, data] of pending) await ref.set(data);
    return result;
  }
  throw new Error("too much contention");
}

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({ doc: docRef, runTransaction }),
  getAdminAuth: () => ({
    getUser: async () => ({
      customClaims: { status: "active", agencyId: "ag_1", agencyRole: null },
    }),
  }),
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));

import { DELETE, GET, PATCH, POST } from "./route";

const url = (query = "") =>
  `http://app.local/api/sub-accounts/${SUB}/whatsapp-senders${query}`;

function call(
  handler: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>,
  init: Omit<RequestInit, "body"> & { body?: unknown } = {},
  query = "",
) {
  const { body, ...rest } = init;
  return handler(
    new Request(url(query), {
      headers: { "content-type": "application/json", "x-user-uid": "uid_admin" },
      ...rest,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SUB }) },
  );
}

async function json(pending: Promise<Response>) {
  const res = await pending;
  return {
    status: res.status,
    body: (await res.json()) as { senders?: WhatsAppSender[]; error?: string; synthesized?: boolean },
  };
}

function setSub(over: Record<string, unknown> = {}) {
  docs.set(`subAccounts/${SUB}`, {
    agencyId: "ag_1",
    whatsappEnabledByAgency: true,
    whatsappProvider: "twilio",
    twilioConfig: { whatsappFromNumber: "+15550001" },
    ...over,
  });
}

const stored = (): WhatsAppSender[] =>
  (docs.get(`subAccounts/${SUB}`)?.whatsappSenders as WhatsAppSender[]) ?? [];

beforeEach(() => {
  writes = [];
  version = 0;
  betweenReadAndCommit = null;
  docs = new Map<string, Record<string, unknown>>([
    [
      `subAccounts/${SUB}/subAccountMembers/uid_admin`,
      { status: "active", subAccountRole: "admin", role: "admin" },
    ],
  ]);
  setSub();
});

describe("exactly one sender is the default", () => {
  it("keeps one default when a second sender is added as the default", async () => {
    await json(
      call(POST, {
        method: "POST",
        body: { label: "Sales", provider: "twilio", phoneNumber: "+15550002" },
      }),
    );
    const { body } = await json(
      call(POST, {
        method: "POST",
        body: {
          label: "Support",
          provider: "cloud",
          phoneNumber: "+27784356159",
          isDefault: true,
        },
      }),
    );
    expect(body.senders?.filter((s) => s.isDefault)).toHaveLength(1);
    expect(body.senders?.find((s) => s.isDefault)?.label).toBe("Support");
  });

  it("moves the default rather than adding one on PATCH", async () => {
    await json(
      call(POST, {
        method: "POST",
        body: { label: "Sales", provider: "twilio", phoneNumber: "+15550002" },
      }),
    );
    const { body: added } = await json(
      call(POST, {
        method: "POST",
        body: { label: "Support", provider: "cloud", phoneNumber: "+27784356159" },
      }),
    );
    const support = added.senders!.find((s) => s.label === "Support")!;
    const { body } = await json(
      call(PATCH, {
        method: "PATCH",
        body: { id: support.id, isDefault: true },
      }),
    );
    expect(body.senders?.filter((s) => s.isDefault).map((s) => s.label)).toEqual(
      ["Support"],
    );
  });

  it("hands the default to a survivor when the default is deleted", async () => {
    // Otherwise a workspace is left with senders and no default, and the
    // resolver falls back to array order for every unset step.
    await json(
      call(POST, {
        method: "POST",
        body: { label: "Sales", provider: "twilio", phoneNumber: "+15550002" },
      }),
    );
    const { body: added } = await json(
      call(POST, {
        method: "POST",
        body: { label: "Support", provider: "cloud", phoneNumber: "+27784356159" },
      }),
    );
    const defaultId = added.senders!.find((s) => s.isDefault)!.id;
    await json(
      call(DELETE, { method: "DELETE" }, `?senderId=${defaultId}`),
    );
    expect(stored().filter((s) => s.isDefault)).toHaveLength(1);
    expect(stored().some((s) => s.id === defaultId)).toBe(false);
  });
});

describe("concurrent writes keep the invariant", () => {
  it("does not lose a sender when two adds interleave", async () => {
    // The second add commits while the first is mid-flight. A read-then-write
    // route overwrites it with an array that never contained it.
    betweenReadAndCommit = async () => {
      await json(
        call(POST, {
          method: "POST",
          body: { label: "Second", provider: "cloud", phoneNumber: "+27784356159" },
        }),
      );
    };
    await json(
      call(POST, {
        method: "POST",
        body: { label: "First", provider: "twilio", phoneNumber: "+15550002" },
      }),
    );
    expect(stored().map((s) => s.label).sort()).toEqual([
      "First",
      "Second",
      "Twilio",
    ]);
    expect(stored().filter((s) => s.isDefault)).toHaveLength(1);
  });

  it("does not drop a 'make default' that lands while an add is in flight", async () => {
    // The interleaved PATCH is the write a read-then-write route loses: the
    // add commits an array built before it, and the default silently snaps
    // back to the sender it was on.
    await json(
      call(POST, {
        method: "POST",
        body: { label: "Sales", provider: "twilio", phoneNumber: "+15550002" },
      }),
    );
    const { body: added } = await json(
      call(POST, {
        method: "POST",
        body: { label: "Support", provider: "cloud", phoneNumber: "+27784356159" },
      }),
    );
    const support = added.senders!.find((s) => s.label === "Support")!;
    betweenReadAndCommit = async () => {
      await json(
        call(PATCH, {
          method: "PATCH",
          body: { id: support.id, isDefault: true },
        }),
      );
    };
    await json(
      call(POST, {
        method: "POST",
        body: { label: "Third", provider: "twilio", phoneNumber: "+15550003" },
      }),
    );
    expect(stored()).toHaveLength(4);
    expect(stored().filter((s) => s.isDefault).map((s) => s.label)).toEqual([
      "Support",
    ]);
  });
});

describe("adding the first sender preserves what the workspace sends on", () => {
  it("materialises the existing rail's number alongside the new one", async () => {
    // The workspace was sending from its Twilio number before the registry
    // existed. Adding a sender must not silently retire it.
    const { body } = await json(
      call(POST, {
        method: "POST",
        body: { label: "Support", provider: "cloud", phoneNumber: "+27784356159" },
      }),
    );
    expect(body.senders?.map((s) => s.phoneNumber)).toEqual([
      "+15550001",
      "+27784356159",
    ]);
    expect(body.senders?.find((s) => s.isDefault)?.phoneNumber).toBe("+15550001");
  });

  it("reports the synthesized sender until one is stored", async () => {
    const before = await json(call(GET));
    expect(before.body.synthesized).toBe(true);
    expect(before.body.senders).toHaveLength(1);
    await json(
      call(POST, {
        method: "POST",
        body: { label: "Support", provider: "cloud", phoneNumber: "+27784356159" },
      }),
    );
    const after = await json(call(GET));
    expect(after.body.synthesized).toBe(false);
  });
});

describe("the writes are gated", () => {
  it("refuses when the agency's WhatsApp gate is off", async () => {
    setSub({ whatsappEnabledByAgency: false });
    const { status } = await json(
      call(POST, {
        method: "POST",
        body: { label: "Sales", provider: "twilio", phoneNumber: "+15550002" },
      }),
    );
    expect(status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it("rejects a number that isn't in international format", async () => {
    const { status, body } = await json(
      call(POST, {
        method: "POST",
        body: { label: "Sales", provider: "twilio", phoneNumber: "0784356159" },
      }),
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/international format/);
    expect(writes).toHaveLength(0);
  });
});
