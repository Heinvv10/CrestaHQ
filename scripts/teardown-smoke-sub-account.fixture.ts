import { expect } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createMemoryFirestore } from "../src/test/memory-firestore";
import { teardownSmokeSubAccount } from "./teardown-smoke-sub-account";
import { SMOKE_PREFIX } from "./teardown-smoke-sub-account-guards";

/** Shared fixture of the teardown script's test files: a smoke sub-account and its sibling. */

export const H = 3600_000;
export const NOW = Date.UTC(2026, 9, 7, 12);
export const PROJECT = "crestahq-test";
export const AG = "ag_1";
export const SA = "sa_smoke";
export const SB = "sa_sibling";

export const mem = createMemoryFirestore();
export const db = mem.db as unknown as Firestore;

/** Everything a smoke run leaves for sub-account `id`, plus what must outlive it. */
export function seedSmoke(id: string) {
  mem.seed(`subAccounts/${id}`, {
    id,
    agencyId: AG,
    name: `${SMOKE_PREFIX}${id}`,
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
export const targetPaths = (id: string) => [
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

export const snapshot = () => new Map(mem.all().map(({ path, data }) => [path, data]));

export const CLIENT_EMAIL = `firebase-adminsdk@${PROJECT}.iam.gserviceaccount.com`;

export async function run(
  opts: { yes?: boolean; projectId?: string; clientEmail?: string; target?: string; using?: Firestore } = {}
) {
  const lines: string[] = [];
  const result = await teardownSmokeSubAccount(
    opts.using ?? db,
    {
      subAccountId: opts.target ?? SA,
      yes: opts.yes ?? true,
      projectId: opts.projectId ?? PROJECT,
      credentialProjectId: PROJECT,
      credentialClientEmail: opts.clientEmail ?? CLIENT_EMAIL,
      now: NOW,
    },
    (line) => lines.push(line)
  );
  return { result, out: lines.join("\n") };
}

/** Runs with `--yes` and asserts a refusal naming `reason` that changed nothing. */
export async function expectRefused(reason: RegExp) {
  const before = snapshot();
  const { result } = await run();
  expect(result.outcome).toBe("refused");
  expect(result.refusals.some((r) => reason.test(r))).toBe(true);
  expect(snapshot()).toEqual(before);
}

type RD = Parameters<typeof mem.db.recursiveDelete>[0];
/** The store, with `before(path)` run ahead of each recursiveDelete and `after(path)` once it is done. */
export const hooked = (before: (path: string) => void, after: (path: string) => void = () => {}) =>
  ({
    ...mem.db,
    recursiveDelete: async (ref: { path: string }) => {
      before(ref.path);
      await mem.db.recursiveDelete(ref as RD);
      after(ref.path);
    },
  }) as unknown as Firestore;

export const patchTarget = (patch: Record<string, unknown>) =>
  mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`), ...patch });

/** Call from each test file's beforeEach: a fresh store with the target and its sibling. */
export function resetStore() {
  mem.clear();
  seedSmoke(SA);
  seedSmoke(SB);
}

