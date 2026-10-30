import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { defaultFormSettings } from "@/types/forms";

/**
 * The submit route echoes `form.settings.redirectUrl` back to the browser,
 * which navigates to it verbatim (`window.location.href = data.redirectUrl`
 * in public-form.tsx). Forms are edited via direct client-SDK writes with no
 * server PATCH route, so a doc written before firestore.rules constrained
 * this field — or written around the rules gap — could still hold a
 * `javascript:` value. The route must never hand one back.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));
const spam = vi.hoisted(() => ({
  result: { kind: "ok" } as { kind: "ok" } | { kind: "trap"; reason: "honeypot" },
}));
vi.mock("@/lib/forms/spam-guard", () => ({
  checkFormSpam: () => spam.result,
  ELAPSED_BODY_KEY: "_elapsed",
  HONEYPOT_BODY_KEY: "_hp",
}));

const { POST } = await import("./route");

function seedForm(redirectUrl: string) {
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("forms/f1", {
    name: "Contact", slug: "contact", enabled: true, submissionCount: 0,
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u_owner",
    fields: [{ id: "name", type: "text", label: "Name", required: false }],
    settings: { ...defaultFormSettings(), redirectUrl },
  });
}

beforeEach(() => {
  mem.clear();
  spam.result = { kind: "ok" };
});

async function submitRedirect(): Promise<string | null> {
  const res = await POST(
    new Request("http://x/api/forms/f1/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { name: "Thandi" } }),
    }),
    { params: Promise.resolve({ id: "f1" }) },
  );
  return ((await res.json()) as { redirectUrl: string | null }).redirectUrl;
}

it("passes through a safe https redirectUrl", async () => {
  seedForm("https://example.com/thanks");
  const res = await POST(
    new Request("http://x/api/forms/f1/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { name: "Thandi" } }),
    }),
    { params: Promise.resolve({ id: "f1" }) },
  );
  const body = (await res.json()) as { redirectUrl: string | null };
  expect(body.redirectUrl).toBe("https://example.com/thanks");
});

it("never returns a javascript: redirectUrl", async () => {
  seedForm("javascript:alert(document.cookie)");
  const res = await POST(
    new Request("http://x/api/forms/f1/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { name: "Thandi" } }),
    }),
    { params: Promise.resolve({ id: "f1" }) },
  );
  const body = (await res.json()) as { redirectUrl: string | null };
  expect(body.redirectUrl).toBeNull();
});

it("passes a relative path through and nulls a protocol-relative one", async () => {
  seedForm("/thanks");
  expect(await submitRedirect()).toBe("/thanks");
  mem.clear();
  seedForm("//evil.com");
  expect(await submitRedirect()).toBeNull();
});

it("guards the redirect echoed on the spam-trap path too", async () => {
  spam.result = { kind: "trap", reason: "honeypot" };
  seedForm("/thanks");
  expect(await submitRedirect()).toBe("/thanks");
  mem.clear();
  seedForm("javascript:alert(1)");
  expect(await submitRedirect()).toBeNull();
  mem.clear();
  seedForm("//evil.com");
  expect(await submitRedirect()).toBeNull();
});
