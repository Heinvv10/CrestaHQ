import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
/** Rows the fake reports as already stored, as `${contactId}/${messageId}`.
 *  Keyed per contact because one phone number can match several contacts and
 *  a partial write leaves the row on some of them and not others. */
let existingMessageIds = new Set<string>();
/** Set to make the conversation upsert throw, as a downstream outage would. */
let upsertThrows = false;
/** Message-doc reads issued — the redelivery check costs exactly one. */
let messageReads: string[] = [];
/** Contact-doc updates from the STOP/START branch. */
let contactUpdates: Array<Record<string, unknown>> = [];
/** Activity rows written by the STOP/START branch, with their doc ids. */
let activityWrites: Array<{ docId: string; data: Record<string, unknown> }> = [];
/** Set to make the opt-out batch commit fail, as contention would. */
let commitThrows = false;
/** `*_received` timeline rows, keyed `${contactId}/${docId}` — a retry that
 *  lands on the same key is what idempotent means here. */
let inboundActivities = new Map<string, Record<string, unknown>>();

function makeSnap(row: { id: string; data: Record<string, unknown> }) {
  const ref = {
    id: row.id,
    collection: (name: string) => ({
      doc: (docId?: string) => ({
        id: docId ?? `generated-${name}-id`,
        get: async () => {
          messageReads.push(docId ?? "");
          return {
            exists:
              existingMessageIds.has(`${row.id}/${docId ?? ""}`) ||
              existingMessageIds.has(docId ?? ""),
            data: () => undefined,
          };
        },
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
        collection: (sub: string) => ({
          doc: (docId?: string) => ({
            set: async (data: Record<string, unknown>) => {
              if (sub !== "activities") throw new Error(`unexpected ${sub}`);
              inboundActivities.set(`${id}/${docId ?? "auto"}`, data);
            },
          }),
        }),
      }),
    };
  },
  // A batch is atomic: nothing it buffers is visible until commit succeeds.
  // Recording at call time instead would report writes that never landed —
  // and the whole point of the retry tests below is what survives a commit
  // that throws.
  batch: () => {
    const pendingUpdates: Array<Record<string, unknown>> = [];
    const pendingSets: Array<{ docId: string; data: Record<string, unknown> }> = [];
    return {
      update: (_ref: unknown, data: Record<string, unknown>) => {
        pendingUpdates.push(data);
      },
      set: (ref: { id?: string }, data: Record<string, unknown>) => {
        pendingSets.push({ docId: ref?.id ?? "", data });
      },
      commit: async () => {
        if (commitThrows) throw new Error("contention");
        contactUpdates.push(...pendingUpdates);
        activityWrites.push(...pendingSets);
      },
    };
  },
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
    if (upsertThrows) throw new Error("conversations index unavailable");
    conversationUpserts.push(a);
  },
}));
/** Most tests keep the AI off; the auto-reply tests switch it on. */
let aiOn = false;
const maybeRespondWithAi = vi.fn();
vi.mock("@/lib/comms/ai/openrouter", () => ({ aiIsConfigured: () => aiOn }));
vi.mock("@/lib/comms/ai/agent", () => ({
  resolveAgent: async () => (aiOn ? { effective: { enabled: true } } : null),
}));
vi.mock("@/lib/comms/ai/respond", () => ({
  maybeRespondWithAi: (...a: unknown[]) => maybeRespondWithAi(...a),
}));

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

// The route clamps `at` into [now - 24h, now], so a fixture pinned to a real
// calendar date is a time bomb: it passed the day it was written and started
// failing every run once it aged past the window, taking `main` red with it.
// The clock is frozen instead, so the fixture stays inside the window forever.
const NOW = new Date("2026-09-05T12:00:00Z");

const inbound = (over: Record<string, unknown> = {}) => ({
  from: "27821234567@s.whatsapp.net",
  text: "hi there",
  messageId: "3EB0ABC",
  at: "2026-09-05T10:00:00Z",
  ...over,
});

describe("POST /api/webhooks/whatsapp/bridge/[subAccountId]", () => {
  beforeEach(() => {
    // Only Date. Faking timers wholesale would stall the awaits in `post`.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    messageWrites = [];
    conversationUpserts = [];
    existingMessageIds = new Set();
    upsertThrows = false;
    messageReads = [];
    contactUpdates = [];
    activityWrites = [];
    inboundActivities = new Map();
    commitThrows = false;
    aiOn = false;
    maybeRespondWithAi.mockReset();
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

  afterEach(() => {
    vi.useRealTimers();
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

  it("writes one whatsapp_received timeline row per matched contact, keyed by the bridge id", async () => {
    await post(inbound());
    expect([...inboundActivities.keys()]).toEqual(["c1/inbound_whatsapp_3EB0ABC"]);
    expect(inboundActivities.get("c1/inbound_whatsapp_3EB0ABC")).toMatchObject({
      type: "whatsapp_received",
      createdBy: "whatsapp_inbound",
      agencyId: "ag_1",
      subAccountId: "sa_1",
      content: "WhatsApp received: hi there",
      meta: { channel: "whatsapp", messageId: "3EB0ABC" },
    });
  });

  it("a redelivery lands on the same timeline row, not a second one", async () => {
    await post(inbound());
    existingMessageIds.add("3EB0ABC");
    await post(inbound());
    expect(messageWrites).toHaveLength(2);
    expect(inboundActivities.size).toBe(1);
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

  it("drops inbound for a sub-account that is not on the bridge rail", async () => {
    // A bridge left running against a switched-back workspace must not keep
    // writing into its threads.
    subAccountDoc = { ...subAccountDoc, whatsappProvider: "twilio" };
    const res = await post(inbound());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "wrong_rail" });
    expect(messageWrites).toHaveLength(0);
  });

  it("accepts inbound when the bridge is a sender but NOT the default", async () => {
    // Membership, not the default. A workspace that sends its campaigns over
    // Cloud still has to receive the replies arriving on its paired number —
    // dropping them loses a real customer message.
    subAccountDoc = {
      ...subAccountDoc,
      whatsappProvider: "cloud",
      whatsappSenders: [
        {
          id: "s_cloud",
          label: "Support",
          provider: "cloud",
          phoneNumber: "+27110000000",
          isDefault: true,
        },
        {
          id: "s_bridge",
          label: "Own number",
          provider: "bridge",
          phoneNumber: "+27784356159",
        },
      ],
    };
    const res = await post(inbound());
    expect(res.status).toBe(200);
    expect(messageWrites).toHaveLength(1);
  });

  it("drops inbound for a workspace whose registry has no bridge sender", async () => {
    subAccountDoc = {
      ...subAccountDoc,
      whatsappSenders: [
        {
          id: "s_cloud",
          label: "Support",
          provider: "cloud",
          phoneNumber: "+27110000000",
          isDefault: true,
        },
      ],
    };
    const res = await post(inbound());
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

  it("drops a LID sender rather than filing it as a phone number", async () => {
    // A LID's user part looks exactly like a long MSISDN. Filed as one, it
    // becomes a contact whose reply is addressed to <lid>@s.whatsapp.net —
    // delivered to whoever really owns that number. This is the exact value
    // seen in production on 2026-09-05.
    const res = await post(inbound({ from: "155228775178345@lid" }));
    expect(await res.json()).toMatchObject({ ignored: "lid" });
    expect(messageWrites).toHaveLength(0);
    expect(createContactServerSide).not.toHaveBeenCalled();
  });

  it("drops every sender address that is not a 1:1 phone JID", async () => {
    // An allow-list, not a deny-list. A newsletter and a bot both arrive with
    // IsGroup false, so a list of "group and LID" lets them through to be
    // filed as contacts with a "+" in front of an id nobody ever dialled.
    for (const from of [
      "120363042000000000@newsletter",
      "867051314767696@bot",
      "27821234567@c.us",
      "27821234567",
      // The "@" anchor: a suffix test without it accepts this as a phone JID.
      "27821234567@evil.s.whatsapp.net",
      // A second "@": endsWith would file this as +27821234567.
      "27821234567@lid@s.whatsapp.net",
      "27821234567@msgr",
      // The trailing anchor: without it the server can be a prefix of anything.
      "27821234567@s.whatsapp.net.evil.example",
    ]) {
      messageWrites.length = 0;
      vi.mocked(createContactServerSide).mockClear();
      const res = await post(inbound({ from }));
      expect(await res.json(), from).toMatchObject({
        ignored: expect.stringMatching(/^(lid|unsupported_jid)$/),
      });
      expect(messageWrites, from).toHaveLength(0);
      expect(createContactServerSide, from).not.toHaveBeenCalled();
    }
  });

  it("reports a hosted LID as a LID, not merely as unsupported", async () => {
    // The reason is the operator's diagnosis: "lid" means a bridge in the
    // fleet predates the SenderAlt fix, which is actionable. Falling through
    // to the generic allow-list would still drop it, but would say nothing
    // about why a real customer went missing.
    const res = await post(inbound({ from: "155228775178345@hosted.lid" }));
    expect(await res.json()).toMatchObject({ ignored: "lid" });
  });

  it("still accepts an ordinary phone sender, device suffix and all", async () => {
    await post(inbound({ from: "27821234567:12@s.whatsapp.net" }));
    expect(messageWrites).toHaveLength(1);
    expect(messageWrites[0].data.from).toBe("+27821234567");
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

  // ---- Findings from the adversarial and architecture reviews ----

  it("answers a sub-account with no bridge credentials exactly like any other pre-auth drop", async () => {
    // The credential lookup must precede authentication — the stored secret IS
    // what authenticates — so its outcome is observable to a caller with no
    // credentials. A distinct status or body here lets anyone probe ids
    // against this public route and learn which sub-accounts have the bridge
    // provisioned. It must be indistinguishable from the other drops.
    getBridgeCreds.mockRejectedValue(new Error("not configured"));
    const res = await post(inbound());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "not_configured" });
    expect(messageWrites).toHaveLength(0);
  });

  it("does not reach Firestore for a sub-account id that is not a plain document id", async () => {
    // The id is interpolated into two document paths. "%2F" survives the
    // middleware pattern that publishes this route, because Next decodes the
    // segment after that match.
    const res = await post(inbound(), { subAccountId: "sa_1/private/whatsappBridge" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "not_configured" });
    expect(getBridgeCreds).not.toHaveBeenCalled();
    expect(messageWrites).toHaveLength(0);
  });

  it("suppresses only the non-idempotent effects on a redelivery", async () => {
    // A signature stays valid for five minutes, so a replayed request used to
    // send another real WhatsApp message per replay. What it must NOT do is
    // skip the idempotent work — see the STOP test below for why that matters.
    existingMessageIds.add("3EB0ABC");
    const res = await post(inbound({ messageId: "3EB0ABC" }));
    expect(res.status).toBe(200);
    expect(conversationUpserts).toHaveLength(0);
    // The row write still runs; it merges onto the same doc id, so it is a
    // no-op in effect and the handler does not have to reason about ordering.
    expect(messageWrites).toHaveLength(1);
  });

  it("honours a STOP that arrives again after the first delivery failed to record it", async () => {
    // The regression an earlier fix introduced. Delivery 1 wrote the message
    // row and then died on the opt-out commit; the retry was swallowed as a
    // duplicate and the opt-out was lost for good. Dropping a STOP is a POPIA
    // failure, not a missing nicety.
    commitThrows = true;
    const first = await post(inbound({ text: "STOP", messageId: "3EB0STOP" }));
    expect(first.status).toBe(503);
    expect(contactUpdates).toEqual([]);

    // The bridge retries anything >= 300. By now the row from delivery 1 is
    // stored, so this IS a redelivery.
    commitThrows = false;
    existingMessageIds.add("3EB0STOP");
    contactUpdates = [];
    const retry = await post(inbound({ text: "STOP", messageId: "3EB0STOP" }));
    expect(retry.status).toBe(200);
    expect(contactUpdates).toEqual([
      expect.objectContaining({ whatsappOptedOut: true }),
    ]);
  });

  it("treats a message as seen when ANY matched contact already holds it", async () => {
    // One phone can match several contacts and the row fans out to all of
    // them. Consulting only contactDocs[0] made the answer depend on
    // Firestore's __name__ ordering: a contact created between deliveries with
    // a smaller id becomes the new [0], has no row, and the message reads as
    // fresh — re-running the auto-reply and sending a second real message.
    aiOn = true;
    contactRows = [
      { id: "c_aaa", data: { name: "New", phone: "+27821234567" } },
      { id: "c_zzz", data: { name: "Thabo", phone: "+27821234567" } },
    ];
    // Stored only on the SECOND contact, which is what a shifted [0] looks like.
    existingMessageIds.add("c_zzz/3EB0SHARED");

    await post(inbound({ messageId: "3EB0SHARED" }));
    expect(maybeRespondWithAi).not.toHaveBeenCalled();
    expect(conversationUpserts).toHaveLength(0);
    // The row write still fans out to both, so the contact that missed it
    // earlier is filled in rather than left permanently without it.
    expect(messageWrites.map((w) => w.contactId).sort()).toEqual([
      "c_aaa",
      "c_zzz",
    ]);
  });

  it("auto-replies on a first delivery but never on a redelivery", async () => {
    // The auto-reply sends a real WhatsApp message to a real person and spends
    // an LLM call, so it is THE effect a replayed request must not repeat —
    // and the reason the five-minute signature window mattered at all.
    aiOn = true;

    await post(inbound({ messageId: "3EB0AI" }));
    expect(maybeRespondWithAi).toHaveBeenCalledTimes(1);

    existingMessageIds.add("3EB0AI");
    maybeRespondWithAi.mockReset();
    await post(inbound({ messageId: "3EB0AI" }));
    expect(maybeRespondWithAi).not.toHaveBeenCalled();
  });

  it("never auto-replies to a STOP", async () => {
    aiOn = true;
    await post(inbound({ text: "STOP", messageId: "3EB0STOPAI" }));
    expect(maybeRespondWithAi).not.toHaveBeenCalled();
  });

  it("keys the opt-out activity row on the message so a retry cannot duplicate it", async () => {
    await post(inbound({ text: "STOP", messageId: "3EB0STOP" }));
    expect(activityWrites).toHaveLength(1);
    expect(activityWrites[0].docId).toBe("whatsapp-optout-3EB0STOP");
    expect(activityWrites[0].data).toMatchObject({
      meta: { kind: "whatsapp_opt_out", optedOut: true },
    });
  });

  it("answers 503 when the opt-out cannot be recorded, so the bridge retries", async () => {
    // Every other failure here degrades to a logged warning and a 200, because
    // a retry costs more than the data lost. This one inverts that.
    commitThrows = true;
    const res = await post(inbound({ text: "STOP", messageId: "3EB0STOP2" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "optout_not_recorded" });
  });

  it("processes a message with no provider id without paying for a dedupe read", async () => {
    // The dedupe key is the provider id. An empty one falls back to a
    // generated Firestore id, which cannot already exist — so the lookup could
    // only ever return "not a duplicate", and issuing it would bill a read per
    // message for an answer that is known in advance.
    const res = await post(inbound({ messageId: "" }));
    expect(res.status).toBe(200);
    expect(messageReads).toEqual([]);
    expect(messageWrites).toHaveLength(1);
    expect(messageWrites[0].data).toMatchObject({ providerMessageId: null });
  });

  it("reads exactly once to check for a redelivery", async () => {
    await post(inbound({ messageId: "3EB0ABC" }));
    expect(messageReads).toEqual(["3EB0ABC"]);
  });

  it("clamps an out-of-range `at` to the boundary rather than to now", async () => {
    // `at` is the bridge's clock, written into the collection
    // readLastInboundAt scans to decide the 24-hour window for the OTHER two
    // rails. Stamping a three-day-old backfill with `now` would make a stale
    // inbound look like it just arrived and hold open a window that is shut —
    // failing open in the one direction that matters. The far edge of the
    // range keeps it old, which is both honest and safe.
    const before = Date.now();
    await post(inbound({ at: "1999-01-01T00:00:00Z", messageId: "id-old" }));
    const old = messageWrites[0].data.createdAt as Date;
    expect(old).toBeInstanceOf(Date);
    expect(old.getTime()).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000);
    expect(old.getTime()).toBeLessThanOrEqual(Date.now() - 24 * 60 * 60 * 1000 + 5000);

    messageWrites = [];
    await post(inbound({ at: "2099-01-01T00:00:00Z", messageId: "id-future" }));
    const future = messageWrites[0].data.createdAt as Date;
    // Nothing legitimately arrives from the future; a skewed clock would
    // otherwise pin the message to the top of the thread forever.
    expect(future.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("still falls back to the server clock when `at` is missing or unparseable", async () => {
    await post(inbound({ at: "not-a-date", messageId: "id-bad" }));
    expect(messageWrites[0].data.createdAt).toBe("SERVER_TS");
  });

  it("keeps a recent `at` so a delayed delivery lands in its real place", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    await post(inbound({ at: recent }));
    expect(messageWrites[0].data.createdAt).toBeInstanceOf(Date);
    expect((messageWrites[0].data.createdAt as Date).toISOString()).toBe(recent);
  });

  it("still answers 200 when the conversation index write fails", async () => {
    // This runs after the message row is committed. Throwing here would make
    // the bridge log a failed delivery for a message that actually landed.
    upsertThrows = true;
    const res = await post(inbound());
    expect(res.status).toBe(200);
    expect(messageWrites).toHaveLength(1);
  });

  it("does not persist when the contact cannot be created", async () => {
    contactRows = [];
    createContactServerSide.mockRejectedValue(new Error("firestore down"));
    const res = await post(inbound());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, persisted: false });
    expect(messageWrites).toHaveLength(0);
  });
});
