import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rail gate on the google-review config SAVE.
 *
 * The route used to ask `subAccountWhatsappIsConfigured(sub.twilioConfig)` —
 * Twilio credentials + a Twilio sender number — for every workspace. A Cloud
 * or bridge workspace has none of those and was refused with "add a WhatsApp
 * sender under Settings → SMS", which is not the fix on either rail.
 *
 * These tests drive the REAL route handler with real fake Firestore documents
 * (the tenancy guard is not mocked either), so they fail if the gate is wrong
 * rather than if a helper beside it is.
 */

const SUB = "sa_1";

let docs: Map<string, Record<string, unknown>>;
let writes: Array<{ path: string; data: Record<string, unknown> }>;

function docRef(path: string) {
  return {
    get: async () => ({
      exists: docs.has(path),
      data: () => docs.get(path),
      id: path.split("/").pop(),
    }),
    set: async (data: Record<string, unknown>) => {
      writes.push({ path, data });
    },
  };
}

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({ doc: docRef }),
  getAdminAuth: () => ({
    getUser: async () => ({
      customClaims: { status: "active", agencyId: "ag_1", agencyRole: null },
    }),
  }),
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));

import { POST } from "./route";

const REVIEW_URL = "https://g.page/r/acme/review";

function post(body: Record<string, unknown>) {
  return POST(
    new Request(`http://app.local/api/sub-accounts/${SUB}/google-review`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-uid": "uid_admin" },
      body: JSON.stringify({ enabled: true, reviewUrl: REVIEW_URL, ...body }),
    }),
    { params: Promise.resolve({ id: SUB }) },
  );
}

async function json(pending: Promise<Response>) {
  const res = await pending;
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

/** Point the sub-account at a rail, with that rail's sender connected. */
function setRail(provider: "twilio" | "cloud" | "bridge", connected = true) {
  const sub: Record<string, unknown> = {
    agencyId: "ag_1",
    whatsappEnabledByAgency: true,
    whatsappProvider: provider,
  };
  if (connected) {
    if (provider === "twilio") {
      sub.twilioConfig = {
        enabled: true,
        accountSid: "AC1",
        authToken: "tok",
        whatsappFromNumber: "+15550002",
      };
    } else if (provider === "cloud") {
      sub.whatsappCloudMeta = { phoneNumberId: "pn_1" };
    } else {
      sub.whatsappBridgeMeta = { displayPhoneNumber: "+27784356159" };
    }
  }
  docs.set(`subAccounts/${SUB}`, sub);
}

beforeEach(() => {
  writes = [];
  docs = new Map<string, Record<string, unknown>>([
    [
      `subAccounts/${SUB}/subAccountMembers/uid_admin`,
      { status: "active", subAccountRole: "admin", role: "admin" },
    ],
  ]);
  setRail("twilio");
});

describe("the sender gate is per rail", () => {
  it("saves a whatsapp_manual config on the BRIDGE rail, which has no Twilio number", async () => {
    setRail("bridge");
    const { status } = await json(
      post({ channel: "whatsapp_manual", messageTemplate: "Review us {{reviewUrl}}" }),
    );
    expect(status).toBe(200);
    const saved = writes.find((w) => w.path === `subAccounts/${SUB}`);
    expect(
      (saved?.data.googleReviewConfig as { channel: string }).channel,
    ).toBe("whatsapp_manual");
  });

  it("saves a whatsapp_template config on the CLOUD rail, which has no Twilio number", async () => {
    setRail("cloud");
    docs.set(`subAccounts/${SUB}/whatsappTemplates/t1`, {
      registrations: {
        cloud: { externalId: "meta_1", status: "approved", rejectionReason: null },
      },
    });
    const { status } = await json(
      post({ channel: "whatsapp_template", whatsappTemplateId: "t1" }),
    );
    expect(status).toBe(200);
    expect(writes.some((w) => w.path === `subAccounts/${SUB}`)).toBe(true);
  });

  it("names the right settings page when a bridge workspace has no sender", async () => {
    setRail("bridge", false);
    const { status, body } = await json(
      post({ channel: "whatsapp_manual", messageTemplate: "Review us {{reviewUrl}}" }),
    );
    expect(status).toBe(400);
    // "Settings → SMS" is the Twilio page and misdirects a bridge operator.
    expect(body.error).not.toContain("Settings → SMS");
    expect(body.error).toContain("Settings → WhatsApp");
    expect(writes).toEqual([]);
  });

  it("still refuses a Twilio workspace with no sender, with the Twilio wording", async () => {
    setRail("twilio", false);
    const { status, body } = await json(
      post({ channel: "whatsapp_manual", messageTemplate: "Review us {{reviewUrl}}" }),
    );
    expect(status).toBe(400);
    expect(body.error).toContain("Settings → SMS");
    expect(writes).toEqual([]);
  });
});

describe("a rail without templates cannot have a template config saved", () => {
  it("refuses whatsapp_template on the bridge and names the rail", async () => {
    setRail("bridge");
    docs.set(`subAccounts/${SUB}/whatsappTemplates/t1`, {
      status: "approved",
      contentSid: "HX1",
    });
    const { status, body } = await json(
      post({ channel: "whatsapp_template", whatsappTemplateId: "t1" }),
    );
    expect(status).toBe(400);
    expect(body.error).toContain("bridge");
    expect(body.error).toContain("can't send templates");
    expect(writes).toEqual([]);
  });

  it("allows whatsapp_manual on the bridge — only templates are unsupported", async () => {
    setRail("bridge");
    const { status } = await json(
      post({ channel: "whatsapp_manual", messageTemplate: "Review us {{reviewUrl}}" }),
    );
    expect(status).toBe(200);
  });
});
