import { beforeEach, describe, expect, it, vi } from "vitest";
import { mem } from "@/test/agent-proposals-harness";
import { pageForm } from "@/test/booking-fixtures";

/** prepareBookingPage reads the sub-account on an edit only for the payment gate, as the PATCH route did. */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());

const { prepareBookingPage } = await import("./booking-page-write");
const subReads = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([p]) => p === "subAccounts/sa1").length;

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
});

describe("prepareBookingPage", () => {
  it("an edit without a deposit doesn't read the sub-account; with one it does", async () => {
    const spy = vi.spyOn(mem.db, "doc");
    expect(await prepareBookingPage("sa1", pageForm("bp1"), { storedType: undefined })).toMatchObject({ ok: true });
    expect(subReads(spy)).toBe(0);
    const paid = pageForm("bp1", { payment: { amount: 10, currency: "USD", description: null, holdHours: 24 } });
    expect(await prepareBookingPage("sa1", paid, { storedType: undefined })).toMatchObject({ ok: false, status: 400 });
    expect(subReads(spy)).toBe(1);
  });

  it("a create reads it (and refuses a missing sub-account)", async () => {
    expect(await prepareBookingPage("sa1", pageForm("bp1"))).toMatchObject({ ok: true, agencyId: "ag1" });
    expect(await prepareBookingPage("sa_gone", pageForm("bp1"))).toMatchObject({ ok: false, status: 404 });
  });
});
