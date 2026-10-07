import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createMemoryFirestore } from "../src/test/memory-firestore";
import { CHANNEL_CONNECTION_FIELDS } from "../src/lib/agency/channel-connections";
import { parseArgs, teardownSmokeSubAccount } from "./teardown-smoke-sub-account";

const H = 3600_000;
const NOW = Date.UTC(2026, 9, 7, 12);
const PROJECT = "crestahq-test";
const AG = "ag_1";
const SA = "sa_smoke";
const SB = "sa_sibling";

const mem = createMemoryFirestore();
const db = mem.db as unknown as Firestore;

/** Everything a smoke run leaves for sub-account `id`, plus what must outlive it. */
function seedSmoke(id: string) {
  mem.seed(`subAccounts/${id}`, {
    id,
    agencyId: AG,
    name: `Agency agent smoke ${id}`,
    createdByKeyId: "key_1",
    createdByUid: "uid_owner",
    createdAt: new Date(NOW - H),
    // As written at creation: empty connections.
    ...{ twilioConfig: null, resendConfig: null, stripeConnectionMeta: null, metaConfig: null },
    ...{ webinar1ConnectionMeta: null, whatsappSenders: [], apexgeoConnected: false },
  });
  mem.seed(`subAccounts/${id}/subAccountMembers/uid_owner`, { role: "admin" });
  mem.seed(`subAccounts/${id}/subAccountMembers/uid_invited`, { role: "collaborator" });
  mem.seed(`userMemberships/uid_owner/subAccounts/${id}`, { subAccountId: id });
  mem.seed(`userMemberships/uid_invited/subAccounts/${id}`, { subAccountId: id });
  mem.seed(`subAccounts/${id}/pipelines/pl_1`, { name: "Sales" });
  mem.seed(`subAccounts/${id}/customFields/cf_1`, { key: "plan" });
  mem.seed(`subAccounts/${id}/bookingPages/demo`, { status: "published" });
  mem.seed(`subAccounts/${id}/aiAgent/profile`, { systemPrompt: "" });
  mem.seed(`subAccounts/${id}/snapshotApplies/snap_1`, { status: "completed" });
  const row = { agencyId: AG, subAccountId: id };
  mem.seed(`workflows/wf_${id}`, { ...row, status: "active" });
  mem.seed(`forms/form_${id}`, row);
  mem.seed(`products/prod_${id}`, row);
  mem.seed(`snippets/snip_${id}`, row);
  mem.seed(`message_templates/welcome_email_${id}`, row);
  mem.seed(`message_templates/welcome_sms_${id}`, row);
  mem.seed(`invites/inv_${id}`, { ...row, email: "x@example.test", acceptedByUid: null, revokedAt: null });
  mem.seed(`agentProposals/p_done_${id}`, { ...row, status: "executed" });
  mem.seed(`agentProposals/p_done_${id}/history/h_1`, { ...row, status: "superseded" });
  mem.seed(`agentProposals/p_gate_${id}`, { agencyId: AG, subAccountId: null, targetSubAccountId: id, status: "rejected" });
  // Audit and agency-side records outlive the sub-account, as the app's delete leaves them.
  mem.seed(`auditEvents/audit_${id}`, row);
  mem.seed(`aiSuiteActions/act_${id}`, row);
}

/** Paths the teardown of `id` must delete — and nothing else. */
const targetPaths = (id: string) => [
  `subAccounts/${id}`,
  `subAccounts/${id}/subAccountMembers/uid_owner`,
  `subAccounts/${id}/subAccountMembers/uid_invited`,
  `userMemberships/uid_owner/subAccounts/${id}`,
  `userMemberships/uid_invited/subAccounts/${id}`,
  `subAccounts/${id}/pipelines/pl_1`,
  `subAccounts/${id}/customFields/cf_1`,
  `subAccounts/${id}/bookingPages/demo`,
  `subAccounts/${id}/aiAgent/profile`,
  `subAccounts/${id}/snapshotApplies/snap_1`,
  `workflows/wf_${id}`,
  `forms/form_${id}`,
  `products/prod_${id}`,
  `snippets/snip_${id}`,
  `message_templates/welcome_email_${id}`,
  `message_templates/welcome_sms_${id}`,
  `invites/inv_${id}`,
  `agentProposals/p_done_${id}`,
  `agentProposals/p_done_${id}/history/h_1`,
  `agentProposals/p_gate_${id}`,
];

const snapshot = () => new Map(mem.all().map(({ path, data }) => [path, data]));

async function run(opts: { yes?: boolean; projectId?: string; target?: string; using?: Firestore } = {}) {
  const lines: string[] = [];
  const result = await teardownSmokeSubAccount(
    opts.using ?? db,
    {
      subAccountId: opts.target ?? SA,
      yes: opts.yes ?? true,
      projectId: opts.projectId ?? PROJECT,
      credentialProjectId: PROJECT,
      now: NOW,
    },
    (line) => lines.push(line)
  );
  return { result, out: lines.join("\n") };
}

/** Runs with `--yes` and asserts a refusal naming `reason` that changed nothing. */
async function expectRefused(reason: RegExp) {
  const before = snapshot();
  const { result } = await run();
  expect(result.outcome).toBe("refused");
  expect(result.refusals.some((r) => reason.test(r))).toBe(true);
  expect(snapshot()).toEqual(before);
}

const patchTarget = (patch: Record<string, unknown>) =>
  mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`), ...patch });

beforeEach(() => {
  mem.clear();
  seedSmoke(SA);
  seedSmoke(SB);
});

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
    ["73 h old", new Date(NOW - 73 * H)],
    ["exactly 72 h old", new Date(NOW - 72 * H)],
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

  it("6. --project must match the credential's project", async () => {
    const before = snapshot();
    const { result } = await run({ projectId: "crestahq-prod" });
    expect(result.outcome).toBe("refused");
    expect(result.refusals).toEqual(["--project crestahq-prod does not match the credential's project (crestahq-test)"]);
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
    for (const header of ["workflows", "forms", "products", "snippets", "message_templates", "invites", "agentProposals (decided)", "userMemberships", `subAccounts/${SA} (recursive)`]) {
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

  it("stops before the sub-account goes when a contact lands mid-run", async () => {
    let landed = false;
    const racing = {
      ...mem.db,
      recursiveDelete: async (ref: { path: string }) => {
        if (!landed && ref.path.startsWith("workflows/")) {
          landed = true;
          mem.seed("contacts/c_late", { agencyId: AG, subAccountId: SA });
        }
        return mem.db.recursiveDelete(ref as Parameters<typeof mem.db.recursiveDelete>[0]);
      },
    } as unknown as Firestore;

    const { result } = await run({ using: racing });

    expect(result.outcome).toBe("refused");
    expect(result.refusals.join()).toMatch(/blocked: contacts/);
    expect(mem.read(`subAccounts/${SA}`)).toBeDefined();
    expect(mem.read(`userMemberships/uid_owner/subAccounts/${SA}`)).toBeDefined();
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
    const watching = {
      ...mem.db,
      recursiveDelete: async (ref: { path: string }) => {
        if (ref.path.startsWith("workflows/")) statuses.push(mem.read(ref.path)?.status);
        return mem.db.recursiveDelete(ref as Parameters<typeof mem.db.recursiveDelete>[0]);
      },
    } as unknown as Firestore;

    const { result } = await run({ using: watching });

    expect(result.outcome).toBe("deleted");
    expect(statuses).toEqual(["paused"]);
  });
});
