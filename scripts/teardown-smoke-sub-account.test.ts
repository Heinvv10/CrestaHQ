import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { CHANNEL_CONNECTION_FIELDS } from "../src/lib/agency/channel-connections";
import { TOP_LEVEL, parseArgs } from "./teardown-smoke-sub-account";
import { MAX_AGE_MS } from "./teardown-smoke-sub-account-guards";
import {
  AG, H, NOW, SA, SB, expectRefused, hooked, mem, patchTarget, resetStore, run, snapshot, targetPaths,
} from "./teardown-smoke-sub-account.fixture";

beforeEach(resetStore);

describe("parseArgs", () => {
  it("requires a project and a sub-account, and defaults to a dry run", () => {
    expect(() => parseArgs(["--sub-account", "sa"])).toThrow(/--project/);
    expect(() => parseArgs(["--project", "p"])).toThrow(/--sub-account/);
    expect(() => parseArgs(["--project", "--sub-account", "sa"])).toThrow(/--project/);
    expect(() => parseArgs(["--project", "p", "--sub-account", "--yes"])).toThrow(/--sub-account/);
    expect(parseArgs(["--project", "p", "--sub-account", "sa"])).toEqual({ projectId: "p", subAccountId: "sa", yes: false });
    expect(parseArgs(["--project", "p", "--sub-account", "sa", "--yes"])).toEqual({ projectId: "p", subAccountId: "sa", yes: true });
    expect(() => parseArgs(["--project", "p", "--sub-account", "a/b"])).toThrow(/one document id/);
  });

});

describe("guards: each one alone refuses and deletes nothing", () => {
  it("refuses a sub-account that does not exist", async () => {
    const before = snapshot();
    const { result } = await run({ target: "sa_missing" });
    expect(result).toMatchObject({ outcome: "refused", refusals: ["subAccounts/sa_missing does not exist"] });
    expect(snapshot()).toEqual(before);
  });

  it.each([
    ["lower case", "agency agent smoke x"],
    ["no trailing space", "Agency agent smoke"],
    ["leading space", " Agency agent smoke x"],
    ["Cyrillic A look-alike", "Аgency agent smoke x"],
    ["non-breaking space", "Agency agent smoke x"],
    ["a real client", "Velocity Fibre"],
    ["missing", undefined],
  ])("1. name prefix — %s", async (_, name) => {
    patchTarget({ name });
    await expectRefused(/^name /);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["not a string", 42],
  ])("2. createdByKeyId — %s", async (_, createdByKeyId) => {
    patchTarget({ createdByKeyId });
    await expectRefused(/^createdByKeyId /);
  });

  it.each([
    ["missing", undefined],
    ["73 h old", new Date(NOW - MAX_AGE_MS - H)],
    ["exactly 72 h old", new Date(NOW - MAX_AGE_MS)],
    ["an invalid Date (NaN ms)", new Date(Number.NaN)],
    ["in the future", new Date(NOW + H)],
    ["a string", "2026-10-07T10:00:00Z"],
  ])("3. createdAt within 72 h — %s", async (_, createdAt) => {
    patchTarget({ createdAt });
    await expectRefused(/^createdAt /);
  });

  it("4. contacts — one contact refuses", async () => {
    mem.seed("contacts/c_1", { agencyId: AG, subAccountId: SA });
    await expectRefused(/^contacts: 1 /);
  });

  it.each(CHANNEL_CONNECTION_FIELDS.map((f) => [f]))("5. channel connection — %s set", async (field) => {
    patchTarget({ [field]: field === "whatsappSenders" ? ["+27000000000"] : field === "apexgeoConnected" ? true : { connectedAt: 1 } });
    await expectRefused(/^channel connection /);
  });

  it("5b. a credential under private/ (a per-member Google Calendar token) refuses", async () => {
    mem.seed(`subAccounts/${SA}/private/googleCalendar_uid_owner`, { refreshToken: "x" });
    await expectRefused(/^private\/ /);
  });

  it.each(["comped", "pending", "active", "past_due"])("5c. Client Billing — billing.status %s refuses", async (status) => {
    patchTarget({ billing: { status, planId: "plan_1", stripeSubscriptionId: status === "active" ? "sub_1" : null } });
    await expectRefused(/^billing: /);
  });

  it("5c. Client Billing — a pending one-time charge refuses", async () => {
    mem.seed("billingCharges/ch_1", { agencyId: AG, subAccountId: SA, status: "pending", amountCents: 50000 });
    await expectRefused(/^billingCharges: ch_1 /);
  });

  it("5c. Client Billing — canceled billing and settled charges do not refuse", async () => {
    patchTarget({ billing: { status: "canceled", planId: "plan_1" } });
    mem.seed("billingCharges/ch_paid", { agencyId: AG, subAccountId: SA, status: "paid" });
    mem.seed("billingCharges/ch_void", { agencyId: AG, subAccountId: SA, status: "canceled" });
    mem.seed("billingCharges/ch_sibling", { agencyId: AG, subAccountId: SB, status: "pending" });
    expect((await run({ yes: false })).result.refusals).toEqual([]);
  });

  it.each([
    ["a provisioned voice line", "voice", { enabled: true, voice: { vapiAssistantId: "asst_1", vapiPhoneNumberId: "pn_1" } }],
    ["a Vapi number only", "voice", { voice: { vapiAssistantId: null, vapiPhoneNumberId: "pn_1" } }],
    ["an assistant on the channel doc itself", "sms", { vapiAssistantId: "asst_2" }],
  ])("5d. voice line — %s refuses", async (_, channel, data) => {
    mem.seed(`subAccounts/${SA}/aiAgent/${channel}`, data);
    await expectRefused(/^voice line: /);
  });

  it("5d. voice line — the default (unprovisioned) voice config does not refuse", async () => {
    mem.seed(`subAccounts/${SA}/aiAgent/voice`, { enabled: false, voice: { vapiAssistantId: null, vapiPhoneNumberId: null } });
    expect((await run({ yes: false })).result.refusals).toEqual([]);
  });

  it("6. --project must match the credential's project", async () => {
    const before = snapshot();
    const { result } = await run({ projectId: "crestahq-prod" });
    expect(result.outcome).toBe("refused");
    expect(result.refusals).toEqual(["--project crestahq-prod does not match the credential's project (crestahq-test)"]);
    expect(snapshot()).toEqual(before);
  });

  it("6. the credential's client email must belong to --project", async () => {
    const before = snapshot();
    const { result } = await run({ clientEmail: "firebase-adminsdk@crestahq-prod.iam.gserviceaccount.com" });
    expect(result.outcome).toBe("refused");
    expect(result.refusals).toEqual([
      "the credential's client email (firebase-adminsdk@crestahq-prod.iam.gserviceaccount.com) is not a service account of crestahq-test",
    ]);
    expect(snapshot()).toEqual(before);
  });

  it.each([
    ["a deal", () => mem.seed("deals/d_1", { agencyId: AG, subAccountId: SA }), /deals/],
    ["a calendar event", () => mem.seed("events/e_1", { agencyId: AG, subAccountId: SA }), /calendar events/],
    [
      "a pending agency-level approval aimed at it",
      () => mem.seed("agentProposals/p_open", { agencyId: AG, subAccountId: null, targetSubAccountId: SA, status: "pending" }),
      /agent approvals waiting or in progress/,
    ],
    [
      "an executing approval on it",
      () => mem.seed("agentProposals/p_exec", { agencyId: AG, subAccountId: SA, status: "executing" }),
      /agent approvals waiting or in progress/,
    ],
  ])("7. findDeleteBlockers — %s", async (_, seed, label) => {
    seed();
    const before = snapshot();
    const { result } = await run();
    expect(result.outcome).toBe("refused");
    expect(result.refusals.some((r) => r.startsWith("blocked: ") && label.test(r))).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it("7. the collections the script deletes itself do not block it", async () => {
    const { result } = await run({ yes: false });
    expect(result.refusals).toEqual([]);
  });
});

describe("dry run", () => {
  it("prints every doc it would delete, by collection, and deletes nothing", async () => {
    const before = snapshot();
    const { result, out } = await run({ yes: false });

    expect(result.outcome).toBe("planned");
    expect(snapshot()).toEqual(before);
    expect([...result.plan.values()].flat().sort()).toEqual(targetPaths(SA).sort());
    for (const path of targetPaths(SA)) expect(out).toContain(path);
    for (const header of [...TOP_LEVEL, "agentProposals (decided)", "userMemberships", `subAccounts/${SA} (recursive)`]) {
      expect(out).toMatch(new RegExp(`^${header.replace(/[()/]/g, "\\$&")} \\(\\d+\\)$`, "m"));
    }
    expect(out).not.toContain(SB);
    expect(out).toMatch(/dry run/i);
  });
});

describe("--yes", () => {
  it("deletes exactly the target's docs; the sibling and the audit trail are untouched", async () => {
    const before = snapshot();
    const { result } = await run();

    expect(result).toMatchObject({ outcome: "deleted", leftovers: [] });
    const after = snapshot();
    const gone = [...before.keys()].filter((p) => !after.has(p)).sort();
    expect(gone).toEqual(targetPaths(SA).sort());
    for (const [path, data] of after) expect(data).toEqual(before.get(path));
  });

  it("fails (leftover) when a doc is still there after the delete", async () => {
    const leaky = {
      ...mem.db,
      recursiveDelete: async (ref: { path: string }) =>
        ref.path.startsWith("invites/") ? undefined : mem.db.recursiveDelete(ref as Parameters<typeof mem.db.recursiveDelete>[0]),
    } as unknown as Firestore;

    const { result, out } = await run({ using: leaky });

    expect(result.outcome).toBe("leftover");
    expect(result.leftovers).toEqual([`invites/inv_${SA}`]);
    expect(out).toContain(`invites/inv_${SA}`);
  });

  it("pauses each workflow before deleting it", async () => {
    const statuses: unknown[] = [];
    const { result } = await run({
      using: hooked((p) => void (p.startsWith("workflows/") && statuses.push(mem.read(p)?.status))),
    });

    expect(result.outcome).toBe("deleted");
    expect(statuses).toEqual(["paused"]);
  });
});
