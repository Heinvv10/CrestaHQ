import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a poll tick does when it cannot tell which rail it is chasing.
 *
 * The route used to fall back to "twilio" on a failed sender resolution.
 * `classifyPollTick` then compared the template against the wrong rail's
 * registration, returned "rail-switched", and the route parked the template as
 * `failed` with a rejection reason that was not true. A guess that writes a
 * terminal state is worse than no answer, so the tick now writes nothing.
 */

const SUB = "sa_1";
const TPL = "tpl_1";
const EXTERNAL_ID = "meta_1";

let docs: Map<string, Record<string, unknown>>;
let updates: Array<{ path: string; data: Record<string, unknown> }>;
const fetchCloudTemplateStatus = vi.fn();
const publishCallback = vi.fn();

function docRef(path: string) {
  return {
    get: async () => ({
      exists: docs.has(path),
      data: () => docs.get(path),
      id: path.split("/").pop(),
    }),
    update: async (data: Record<string, unknown>) => {
      updates.push({ path, data });
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
  };
}

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({ doc: docRef }),
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  verifyQStashSignature: async () => true,
  publishCallback: (...a: unknown[]) => publishCallback(...a),
}));
vi.mock("@/lib/comms/whatsapp/cloud-credentials", () => ({
  getWabaCreds: async () => ({
    phoneNumberId: "pn_1",
    wabaId: "waba_1",
    accessToken: "tok",
  }),
}));
vi.mock("@/lib/comms/whatsapp/cloud-templates", () => ({
  fetchCloudTemplateStatus: (...a: unknown[]) => fetchCloudTemplateStatus(...a),
  CloudTemplateError: class extends Error {},
}));
vi.mock("@/lib/comms/whatsapp/templates-api", () => ({
  fetchApprovalStatus: async () => ({ status: "approved", rejectionReason: null }),
  WhatsappContentError: class extends Error {},
}));

import { POST } from "./route";

/** A sender that cannot be resolved: per-sender credentials aren't supported,
 *  so the resolver refuses rather than sending on another sender's account. */
const UNRESOLVABLE_SENDER = {
  id: "s_cloud",
  label: "Support",
  provider: "cloud",
  phoneNumber: "+27784356159",
  isDefault: true,
  credentialsId: "cred_1",
};

const RESOLVABLE_SENDER = { ...UNRESOLVABLE_SENDER, credentialsId: undefined };

function setSub(senders: Record<string, unknown>[]) {
  docs.set(`subAccounts/${SUB}`, {
    agencyId: "ag_1",
    whatsappEnabledByAgency: true,
    // Twilio is the LEGACY field — the value the old fallback guessed, and the
    // rail this template was never submitted on.
    whatsappProvider: "twilio",
    twilioConfig: { accountSid: "AC1", authToken: "tok" },
    whatsappSenders: senders,
  });
}

async function poll(contentSid = EXTERNAL_ID) {
  const res = await POST(
    new Request(
      `http://app.local/api/sub-accounts/${SUB}/whatsapp-templates/poll`,
      {
        method: "POST",
        headers: { "upstash-signature": "sig" },
        body: JSON.stringify({
          subAccountId: SUB,
          templateId: TPL,
          contentSid,
        }),
      },
    ),
    { params: Promise.resolve({ id: SUB }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  updates = [];
  publishCallback.mockReset().mockResolvedValue({ messageId: "m1" });
  fetchCloudTemplateStatus
    .mockReset()
    .mockResolvedValue({ status: "approved", reason: null });
  docs = new Map<string, Record<string, unknown>>([
    [
      `subAccounts/${SUB}/whatsappTemplates/${TPL}`,
      {
        status: "pending",
        name: "cresta_audit_offer",
        language: "en",
        pollAttempts: 0,
        registrations: {
          cloud: {
            externalId: EXTERNAL_ID,
            status: "pending",
            rejectionReason: null,
          },
        },
      },
    ],
  ]);
});

describe("a tick that cannot resolve the sender", () => {
  it("writes nothing and says why", async () => {
    setSub([UNRESOLVABLE_SENDER]);
    const { status, body } = await poll();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, ignored: "sender-unresolved" });
    // The template is untouched — not parked as failed on a guessed rail.
    expect(updates).toHaveLength(0);
    expect(
      docs.get(`subAccounts/${SUB}/whatsappTemplates/${TPL}`)?.status,
    ).toBe("pending");
  });

  it("still polls normally when the sender DOES resolve", async () => {
    // The control: without this, the test above would pass on a route that
    // does nothing at all.
    setSub([RESOLVABLE_SENDER]);
    const { body } = await poll();
    expect(body).toMatchObject({ ok: true });
    expect(fetchCloudTemplateStatus).toHaveBeenCalledTimes(1);
    expect(
      docs.get(`subAccounts/${SUB}/whatsappTemplates/${TPL}`)?.status,
    ).toBe("approved");
  });
});

describe("a tick whose next poll cannot be queued", () => {
  it("parks the template as failed (re-submittable) with the reason when the publish resolves null", async () => {
    setSub([RESOLVABLE_SENDER]);
    fetchCloudTemplateStatus.mockResolvedValue({ status: "pending", reason: null });
    publishCallback.mockResolvedValue(null);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { body } = await poll();
    expect(body).toEqual({ ok: true, settled: "unscheduled" });
    const tpl = docs.get(`subAccounts/${SUB}/whatsappTemplates/${TPL}`);
    expect(tpl?.status).toBe("failed");
    expect(tpl?.rejectionReason).toMatch(/Could not schedule the next approval check/);
    expect(error).toHaveBeenCalledWith(
      `[whatsapp-templates/poll] next poll not queued sa=${SUB} template=${TPL}`,
    );
    error.mockRestore();
  });

  it("stays pending and reports deferred when the publish is queued", async () => {
    setSub([RESOLVABLE_SENDER]);
    fetchCloudTemplateStatus.mockResolvedValue({ status: "pending", reason: null });
    const { body } = await poll();
    expect(body).toEqual({ ok: true, deferred: "pending" });
    expect(docs.get(`subAccounts/${SUB}/whatsappTemplates/${TPL}`)?.status).toBe("pending");
  });
});

describe("a resubmitted template's poll chain", () => {
  it("tick N gets a different dedup id from the earlier submission's tick N", async () => {
    setSub([RESOLVABLE_SENDER]);
    fetchCloudTemplateStatus.mockResolvedValue({ status: "pending", reason: null });
    const path = `subAccounts/${SUB}/whatsappTemplates/${TPL}`;
    await poll();
    // Resubmitted: a new Meta id, and the attempt count back at 0.
    docs.set(path, {
      ...docs.get(path),
      pollAttempts: 0,
      registrations: { cloud: { externalId: "meta_2", status: "pending", rejectionReason: null } },
    });
    await poll("meta_2");
    const ids = publishCallback.mock.calls.map(([o]) => (o as { deduplicationId: string }).deduplicationId);
    expect(ids).toEqual([`watpl_${SUB}_${TPL}_meta_1_1`, `watpl_${SUB}_${TPL}_meta_2_1`]);
  });
});
