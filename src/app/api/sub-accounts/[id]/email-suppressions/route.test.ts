import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The admin-managed suppression list, end to end with the send helper: an
 * address added here is refused by `sendEmail`, and removing it lets the next
 * send through. Only the SMTP wire and auth are stubbed.
 */

const s = () => import("@/test/email-suppression-seam");
const auth = vi.hoisted(() => ({ result: null as unknown }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => auth.result,
}));
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/comms/smtp", async () => (await s()).seamMocks.smtp());
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));

const { SA, AGENCY, SMTP_SUB, mem, resetSeam, wireRecipients } = await s();
const { GET, POST, DELETE } = await import("./route");
const { sendEmail } = await import("@/lib/comms/resend");

const ctx = { params: Promise.resolve({ id: SA }) };
const url = `https://app.test/api/sub-accounts/${SA}/email-suppressions`;
const add = (body: unknown) =>
  POST(new Request(url, { method: "POST", body: JSON.stringify(body) }), ctx);
const send = (to: string) =>
  sendEmail({ to, subject: "Hi", text: "Hello", subAccount: SMTP_SUB as never, meter: { subAccountId: SA } });

beforeEach(() => {
  resetSeam();
  auth.result = { uid: "admin1", subAccountId: SA, subAccountRole: "admin" };
});

describe("email suppressions API", () => {
  it("refuses a caller the admin gate refuses, writing nothing", async () => {
    auth.result = NextResponse.json({ error: "Sub-account admin only" }, { status: 403 });
    expect((await add({ email: "x@example.com" })).status).toBe(403);
    expect(mem.list(`subAccounts/${SA}/emailSuppressions`)).toEqual([]);
  });

  it("rejects an invalid address and an unknown reason", async () => {
    expect((await add({ email: "not-an-email" })).status).toBe(400);
    expect((await add({ email: "x@example.com", reason: "vibes" })).status).toBe(400);
    expect(mem.list(`subAccounts/${SA}/emailSuppressions`)).toEqual([]);
  });

  it("stores a normalised address with tenancy keys, and the send helper then refuses it", async () => {
    expect((await add({ email: " Gone@Example.com ", note: "bounced in Outlook" })).status).toBe(200);
    const [row] = mem.list(`subAccounts/${SA}/emailSuppressions`);
    expect(row).toMatchObject({
      agencyId: AGENCY,
      subAccountId: SA,
      createdByUid: "admin1",
      email: "gone@example.com",
      reason: "manual",
      note: "bounced in Outlook",
    });
    await expect(send("gone@example.com")).rejects.toThrow("suppression list");
    expect(wireRecipients()).toEqual([]);

    const list = await (await GET(new Request(url), ctx)).json();
    expect(list.items).toEqual([expect.objectContaining({ email: "gone@example.com", reason: "manual" })]);
  });

  it("removing an address lets the next send through", async () => {
    await add({ email: "gone@example.com", reason: "hard_bounce" });
    await DELETE(new Request(`${url}?email=${encodeURIComponent("GONE@example.com")}`, { method: "DELETE" }), ctx);
    expect(mem.list(`subAccounts/${SA}/emailSuppressions`)).toEqual([]);
    await send("gone@example.com");
    expect(wireRecipients()).toEqual(["gone@example.com"]);
  });
});
