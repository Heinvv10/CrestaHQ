import { beforeEach, describe, expect, it, vi } from "vitest";
import { signWebhookPayload } from "@/lib/api/webhooks/signing";

/**
 * Route-handler tests for the wa-agent-bridge inbound webhook.
 *
 * Firestore is faked rather than emulated: what matters here is WHICH writes
 * the handler issues, under which credentials, and which payloads it refuses
 * to write at all. A recording fake captures exactly that.
 */

const CREDS = {
  baseUrl: "http://bridge.local:33001",
  token: "tok_secret",
  webhookSecret: "whsec_test",
};

interface MessageWrite {
  contactId: string;
  docId: string;
  data: Record<string, unknown>;
  opts: unknown;
}

let contactRows: Array<{ id: string; data: Record<string, unknown> }> = [];
let subAccountDoc: Record<string, unknown> | undefined;
let messageWrites: MessageWrite[] = [];
let conversationUpserts: Array<Record<string, unknown>> = [];

function makeSnap(row: { id: string; data: Record<string, unknown> }) {
  const ref = {
    id: row.id,
    collection: (name: string) => ({
      doc: (docId?: string) => ({
        id: docId ?? "generated-id",
        set: async (data: Record<string, unknown>, opts: unknown) => {
          if (name === "whatsappMessages") {
            messageWrites.push({
              contactId: row.id,
              docId: docId ?? "",
              data,
              opts,
            });
          }
        },
      }),
    }),
  };
  return { id: row.id, data: () => row.data, ref };
}

const contactsQuery = {
  where: () => contactsQuery,
  limit: () => contactsQuery,
  get: async () => ({
    empty: contactRows.length === 0,
    docs: contactRows.map(makeSnap),
  }),
};

const fakeDb = {
  doc: (path: string) => ({
    get: async () => ({
      exists: subAccountDoc !== undefined,
      data: () => subAccountDoc,
      id: path.split("/")[1],
    }),
  }),
  collection: (name: string) => {
    if (name !== "contacts") throw new Error(`unexpected collection ${name}`);
    return {
      ...contactsQuery,
      doc: (id?: string) => ({
        id: id ?? "generated-contact-id",
        get: async () => makeSnap(contactRows[contactRows.length - 1]),
      }),
    };
  },
  batch: () => ({
    update: () => {},
    set: () => {},
    commit: async () => {},
  }),
};

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => fakeDb }));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));

const getBridgeCreds = vi.fn();
vi.mock("@/lib/comms/whatsapp/bridge-credentials", () => ({
  getBridgeCreds: (...a: unknown[]) => getBridgeCreds(...a),
}));

const createContactServerSide = vi.fn();
vi.mock("@/lib/server/contacts-service", () => ({
  createContactServerSide: (...a: unknown[]) => createContactServerSide(...a),
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async (a: Record<string, unknown>) => {
    conversationUpserts.push(a);
  },
}));
vi.mock("@/lib/comms/ai/openrouter", () => ({ aiIsConfigured: () => false }));
vi.mock("@/lib/comms/ai/agent", () => ({ resolveAgent: async () => null }));
vi.mock("@/lib/comms/ai/respond", () => ({ maybeRespondWithAi: async () => {} }));

import { POST } from "./route";

function post(
  payload: Record<string, unknown>,
  opts: {
    secret?: string;
    token?: string;
    header?: string | null;
    subAccountId?: string;
  } = {},
) {
  const rawBody = JSON.stringify(payload);
  const signed = signWebhookPayload(opts.secret ?? CREDS.webhookSecret, rawBody);
  const headers = new Headers({ "content-type": "application/json" });
  const header = opts.header === undefined ? signed.header : opts.header;
  if (header !== null) headers.set("leadstack-signature", header);
  headers.set("authorization", `Bearer ${opts.token ?? CREDS.token}`);
  return POST(
    new Request("http://app.local/api/webhooks/whatsapp/bridge/sa_1", {
      method: "POST",
      headers,
      body: rawBody,
    }),
    { params: Promise.resolve({ subAccountId: opts.subAccountId ?? "sa_1" }) },
  );
}

const inbound = (over: Record<string, unknown> = {}) => ({
  from: "27821234567@s.whatsapp.net",
  text: "hi there",
  messageId: "3EB0ABC",
  at: "2026-09-05T10:00:00Z",
  ...over,
});

describe("POST /api/webhooks/whatsapp/bridge/[subAccountId]", () => {
  beforeEach(() => {
    messageWrites = [];
    conversationUpserts = [];
    contactRows = [
      { id: "c1", data: { name: "Thabo", phone: "+27821234567" } },
    ];
    subAccountDoc = {
      agencyId: "ag_1",
      whatsappEnabledByAgency: true,
      whatsappProvider: "bridge",
      whatsappBridgeMeta: { displayPhoneNumber: "+27784356159" },
    };
    getBridgeCreds.mockReset();
    getBridgeCreds.mockResolvedValue(CREDS);
    createContactServerSide.mockReset();
  });

  it("writes the message row and upserts the conversation for a signed payload", async () => {
    const res = await post(inbound());
    expect(res.status).toBe(200);
    expect(messageWrites).toHaveLength(1);
    expect(messageWrites[0].data).toMatchObject({
      direction: "inbound",
      status: "received",
      body: "hi there",
      from: "+27821234567",
      provider: "bridge",
      providerMessageId: "3EB0ABC",
      twilioMessageSid: null,
      subAccountId: "sa_1",
      agencyId: "ag_1",
    });
    expect(conversationUpserts).toHaveLength(1);
    expect(conversationUpserts[0]).toMatchObject({
      contactId: "c1",
      channel: "whatsapp",
      direction: "inbound",
    });
  });

  it("stamps createdAt from the payload's `at`, not the write time", async () => {
    await post(inbound());
    expect(messageWrites[0].data.createdAt).toEqual(
      new Date("2026-09-05T10:00:00Z"),
    );
  });

  it("falls back to the server timestamp when `at` is unparseable", async () => {
    await post(inbound({ at: "not-a-date" }));
    expect(messageWrites[0].data.createdAt).toBe("SERVER_TS");
  });

  it("rejects a bad signature with 403 and writes nothing", async () => {
    const res = await post(inbound(), { secret: "wrong-secret" });
    expect(res.status).toBe(403);
    expect(messageWrites).toHaveLength(0);
  });

  it("rejects a missing signature header with 403", async () => {
    const res = await post(inbound(), { header: null });
    expect(res.status).toBe(403);
    expect(messageWrites).toHaveLength(0);
  });

  it("rejects a correctly signed payload carrying the wrong bearer token", async () => {
    // The signature proves the body; the token proves the caller. A bridge
    // pointed at another workspace's URL must fail even if it signs cleanly.
    const res = await post(inbound(), { token: "tok_other" });
    expect(res.status).toBe(403);
    expect(messageWrites).toHaveLength(0);
  });

  it("404s a sub-account with no bridge credentials", async () => {
    getBridgeCreds.mockRejectedValue(new Error("not configured"));
    const res = await post(inbound());
    expect(res.status).toBe(404);
    expect(messageWrites).toHaveLength(0);
  });

  it("drops inbound for a sub-account that is not on the bridge rail", async () => {
    // A bridge left running against a switched-back workspace must not keep
    // writing into its threads.
    subAccountDoc = { ...subAccountDoc, whatsappProvider: "twilio" };
    const res = await post(inbound());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "wrong_rail" });
    expect(messageWrites).toHaveLength(0);
  });

  it("drops inbound when the agency gate is off", async () => {
    subAccountDoc = { ...subAccountDoc, whatsappEnabledByAgency: false };
    const res = await post(inbound());
    expect(await res.json()).toMatchObject({ ignored: "channel_disabled" });
    expect(messageWrites).toHaveLength(0);
  });

  it("drops a group message — the bridge is 1:1 only", async () => {
    const res = await post(inbound({ from: "1234-5678@g.us" }));
    expect(await res.json()).toMatchObject({ ignored: "group" });
    expect(messageWrites).toHaveLength(0);
  });

  it("matches the stored contact through a multi-device suffix", async () => {
    // An un-stripped ":12" would mint a duplicate contact on every inbound
    // from a multi-device account.
    await post(inbound({ from: "27821234567:12@s.whatsapp.net" }));
    expect(createContactServerSide).not.toHaveBeenCalled();
    expect(messageWrites[0].contactId).toBe("c1");
    expect(messageWrites[0].data.from).toBe("+27821234567");
  });

  it("keys the row on the bridge message id so a redelivery merges", async () => {
    await post(inbound());
    await post(inbound());
    expect(messageWrites.map((w) => w.docId)).toEqual(["3EB0ABC", "3EB0ABC"]);
    expect(messageWrites[0].opts).toEqual({ merge: true });
  });

  it("auto-creates an unknown sender with no name and the bridge uid", async () => {
    contactRows = [];
    createContactServerSide.mockImplementation(async () => {
      contactRows = [{ id: "c_new", data: { phone: "+27821234567" } }];
      return { id: "c_new" };
    });
    await post(inbound());
    expect(createContactServerSide).toHaveBeenCalledWith(
      expect.objectContaining({
        createdByUid: "bridge-whatsapp-inbound",
        source: "whatsapp",
        name: "",
        phone: "+27821234567",
      }),
    );
    expect(messageWrites[0].contactId).toBe("c_new");
  });

  it("does not mint a contact for a never-seen number whose first word is STOP", async () => {
    contactRows = [];
    const res = await post(inbound({ text: "STOP" }));
    expect(createContactServerSide).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ persisted: false });
  });

  it("writes the message row BEFORE handling an opt-out", async () => {
    // The row must capture what the customer actually sent, even STOP.
    const res = await post(inbound({ text: "STOP" }));
    expect(messageWrites).toHaveLength(1);
    expect(messageWrites[0].data.body).toBe("STOP");
    expect(await res.json()).toMatchObject({ optedOut: true });
  });
});
