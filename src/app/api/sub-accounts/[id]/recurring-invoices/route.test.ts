import { beforeEach, describe, expect, it, vi } from "vitest";
import { mem } from "@/test/agent-proposals-harness";

/** POST /recurring-invoices, now building its doc with
 *  lib/server/recurring-schedule-write.ts: it still writes the schedule,
 *  and still refuses as before. */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());

const { POST } = await import("./route");
const post = (body: Record<string, unknown>) =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "sa1" }) });
const BODY = { contactId: "c1", name: "Retainer", cadence: { unit: "month", interval: 1 }, startDateString: "2030-01-01", lineItems: [{ description: "Support", quantity: 1, unitPrice: 1000 }], currency: "ZAR" };

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", timezone: "UTC" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann", email: "ann@x.io" });
});

describe("POST /recurring-invoices", () => {
  it("writes an active schedule with its first run", async () => {
    const res = await post(BODY);
    expect(res.status).toBe(201);
    const { id, nextRunAt } = (await res.json()) as { id: string; nextRunAt: string };
    expect(nextRunAt).toBe("2030-01-01T00:00:00.000Z");
    expect(mem.read(`recurringInvoices/${id}`)).toMatchObject({ subAccountId: "sa1", contactId: "c1", name: "Retainer", status: "active", currency: "ZAR", cyclesGenerated: 0, createdByUid: "u_admin" });
  });

  it.each([
    ["a contact with no email", () => mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann", email: "" }), 400],
    ["another sub-account's contact", () => mem.seed("contacts/c1", { subAccountId: "sa2", email: "ann@x.io" }), 404],
  ])("%s -> %s, nothing written", async (_label, arrange, status) => {
    arrange();
    expect((await post(BODY)).status).toBe(status);
    expect(mem.list("recurringInvoices")).toEqual([]);
  });
});
