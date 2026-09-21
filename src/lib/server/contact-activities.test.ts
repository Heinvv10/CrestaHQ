import { beforeEach, expect, it, vi } from "vitest";
import { writeInboundMessageActivity } from "./contact-activities";

/**
 * Providers retry webhooks; the activity must be keyed by the provider's
 * message id so the retry lands on the same doc instead of a duplicate.
 */

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));

const docs = new Map<string, Record<string, unknown>>();
let autoIds = 0;

function fakeDb() {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id?: string) => {
            const key = id ?? `auto_${++autoIds}`;
            return {
              set: async (data: Record<string, unknown>) => {
                docs.set(key, { ...(docs.get(key) ?? {}), ...data });
              },
            };
          },
        }),
      }),
    }),
  } as unknown as FirebaseFirestore.Firestore;
}

const base = {
  contactId: "c_1",
  channel: "sms" as const,
  preview: "hello",
  agencyId: "ag_1",
  subAccountId: "sa_1",
};

beforeEach(() => {
  docs.clear();
  autoIds = 0;
});

it("writes the same message twice into one deterministic doc", async () => {
  const db = fakeDb();
  await writeInboundMessageActivity(db, { ...base, messageId: "SM1" });
  await writeInboundMessageActivity(db, { ...base, messageId: "SM1" });
  expect([...docs.keys()]).toEqual(["inbound_sms_SM1"]);
  expect(docs.get("inbound_sms_SM1")).toMatchObject({
    type: "sms_received",
    createdBy: "sms_inbound",
    meta: { channel: "sms", messageId: "SM1" },
  });
});

it("keys by channel too, so the same id on two channels stays two rows", async () => {
  const db = fakeDb();
  await writeInboundMessageActivity(db, { ...base, messageId: "X" });
  await writeInboundMessageActivity(db, {
    ...base,
    channel: "whatsapp",
    messageId: "X",
  });
  expect([...docs.keys()].sort()).toEqual([
    "inbound_sms_X",
    "inbound_whatsapp_X",
  ]);
});

it("falls back to an auto id only when there is no provider id", async () => {
  const db = fakeDb();
  await writeInboundMessageActivity(db, { ...base, messageId: null });
  await writeInboundMessageActivity(db, { ...base, messageId: null });
  expect([...docs.keys()]).toEqual(["auto_1", "auto_2"]);
});

it("never throws — a broken db logs and the webhook still acks", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const broken = {
    collection: () => ({ doc: () => ({}) }),
  } as unknown as FirebaseFirestore.Firestore;
  await expect(
    writeInboundMessageActivity(broken, { ...base, messageId: "SM1" })
  ).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

it("keeps a slash-bearing email Message-ID a valid single doc id", async () => {
  const db = fakeDb();
  await writeInboundMessageActivity(db, {
    ...base,
    channel: "email",
    messageId: "<a/b@example.com>",
  });
  expect([...docs.keys()]).toEqual(["inbound_email_<a_b@example.com>"]);
});
