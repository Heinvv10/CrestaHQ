import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";
import {
  normalizeDeliveryStatus,
  recordWhatsappDeliveryStatus,
  type DeliveryStatus,
} from "./delivery-status";

const mem = createMemoryFirestore();
const db = mem.db as unknown as Firestore;
const PHONE = "+27821234567";

function seedRow(path: string, over: Record<string, unknown> = {}) {
  mem.seed(path, {
    subAccountId: "sa1", direction: "outbound", status: "sent", error: null, body: "hi", ...over,
  });
}

const record = (status: DeliveryStatus, over: Record<string, unknown> = {}) =>
  recordWhatsappDeliveryStatus({
    db, subAccountId: "sa1", recipientPhone: PHONE, providerMessageId: "wamid.1", status, ...over,
  });

beforeEach(() => {
  mem.clear();
  mem.seed("contacts/c1", { subAccountId: "sa1", phone: PHONE });
  seedRow("contacts/c1/whatsappMessages/wamid.1");
});

describe("recordWhatsappDeliveryStatus", () => {
  it("marks the row failed with the provider's code and title", async () => {
    expect(await record("failed", { errorCode: "131047", errorTitle: "Re-engagement message" })).toEqual({ updated: 1 });
    expect(mem.read("contacts/c1/whatsappMessages/wamid.1")).toMatchObject({
      status: "failed", error: "131047: Re-engagement message", body: "hi",
    });
  });

  it("moves forward sent → delivered → read", async () => {
    await record("delivered");
    expect(mem.read("contacts/c1/whatsappMessages/wamid.1")?.status).toBe("delivered");
    await record("read");
    expect(mem.read("contacts/c1/whatsappMessages/wamid.1")?.status).toBe("read");
  });

  it("never moves backward: a late delivered keeps read, and failed is final", async () => {
    await record("read");
    expect(await record("delivered")).toEqual({ updated: 0 });
    expect(mem.read("contacts/c1/whatsappMessages/wamid.1")?.status).toBe("read");

    seedRow("contacts/c1/whatsappMessages/wamid.1", { status: "failed", error: "63016: x" });
    await record("delivered");
    await record("read");
    expect(mem.read("contacts/c1/whatsappMessages/wamid.1")).toMatchObject({ status: "failed", error: "63016: x" });
  });

  it("is idempotent on a redelivered receipt", async () => {
    await record("failed", { errorCode: "131026" });
    expect(await record("failed", { errorCode: "131026" })).toEqual({ updated: 0 });
    expect(mem.read("contacts/c1/whatsappMessages/wamid.1")?.error).toBe("131026");
  });

  it("never creates a row for an unknown message id", async () => {
    expect(await record("failed", { providerMessageId: "wamid.unknown" })).toEqual({ updated: 0 });
    expect(mem.read("contacts/c1/whatsappMessages/wamid.unknown")).toBeUndefined();
  });

  it("never touches another sub-account's row with the same id and phone", async () => {
    mem.seed("contacts/c2", { subAccountId: "sa2", phone: PHONE });
    seedRow("contacts/c2/whatsappMessages/wamid.1", { subAccountId: "sa2" });
    await record("failed", { errorCode: "131047" });
    expect(mem.read("contacts/c2/whatsappMessages/wamid.1")?.status).toBe("sent");
  });

  it("never touches a row under another sub-account's contact, whatever the row claims", async () => {
    mem.seed("contacts/c2", { subAccountId: "sa2", phone: PHONE });
    seedRow("contacts/c2/whatsappMessages/wamid.1", { subAccountId: "sa1" });
    await record("failed");
    expect(mem.read("contacts/c2/whatsappMessages/wamid.1")?.status).toBe("sent");
  });

  it("ignores a row whose own subAccountId disagrees with its contact", async () => {
    seedRow("contacts/c1/whatsappMessages/wamid.1", { subAccountId: "sa2" });
    expect(await record("failed")).toEqual({ updated: 0 });
  });

  it("never rewrites an inbound row", async () => {
    seedRow("contacts/c1/whatsappMessages/wamid.1", { direction: "inbound", status: "received" });
    expect(await record("failed")).toEqual({ updated: 0 });
    expect(mem.read("contacts/c1/whatsappMessages/wamid.1")?.status).toBe("received");
  });
});

describe("normalizeDeliveryStatus", () => {
  it("maps both rails' vocabularies", () => {
    expect(normalizeDeliveryStatus("undelivered")).toBe("failed");
    expect(normalizeDeliveryStatus("failed")).toBe("failed");
    expect(normalizeDeliveryStatus("read")).toBe("read");
    expect(normalizeDeliveryStatus("queued")).toBeNull();
    expect(normalizeDeliveryStatus("sending")).toBeNull();
  });
});
