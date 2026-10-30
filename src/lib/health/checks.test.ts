import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({ collection: () => ({ doc: () => ({ get: async () => ({}) }) }) }),
}));

import { runHealthChecks } from "./checks";

const LEGACY_LABEL = "Legacy signing keys (old account)";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  vi.stubEnv("QSTASH_URL", "https://qstash.example.com");
  vi.stubEnv("QSTASH_TOKEN", "test-token");
  vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "sig_current");
  vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "sig_next");
  vi.stubEnv("QSTASH_LEGACY_CURRENT_SIGNING_KEY", "");
  vi.stubEnv("QSTASH_LEGACY_NEXT_SIGNING_KEY", "");
  vi.stubEnv("FIREBASE_ADMIN_PROJECT_ID", "p");
  vi.stubEnv("FIREBASE_ADMIN_CLIENT_EMAIL", "a@p.iam.gserviceaccount.com");
  vi.stubEnv("FIREBASE_ADMIN_PRIVATE_KEY", "k");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function cards() {
  const all = await runHealthChecks();
  return {
    qstash: all.find((c) => c.id === "qstash")!,
    firebaseAdmin: all.find((c) => c.id === "firebase-admin")!,
  };
}

describe("QStash health card — the optional legacy signing-key pair", () => {
  it("shows nothing for the legacy pair when neither key is set", async () => {
    const { qstash } = await cards();
    expect(qstash.status).toBe("ok");
    expect(qstash.subChecks.map((s) => s.label)).not.toContain(LEGACY_LABEL);
  });

  it("is ok when both legacy keys are set", async () => {
    vi.stubEnv("QSTASH_LEGACY_CURRENT_SIGNING_KEY", "sig_legacy_current");
    vi.stubEnv("QSTASH_LEGACY_NEXT_SIGNING_KEY", "sig_legacy_next");
    const { qstash } = await cards();
    expect(qstash.subChecks.find((s) => s.label === LEGACY_LABEL)?.status).toBe("ok");
    expect(qstash.status).toBe("ok");
  });

  it("is partial on the QStash card — and leaves Firebase alone — when only one key is set", async () => {
    for (const [current, next] of [
      ["sig_legacy_current", ""],
      ["", "sig_legacy_next"],
      ["sig_legacy_current", "   "],
    ]) {
      vi.stubEnv("QSTASH_LEGACY_CURRENT_SIGNING_KEY", current);
      vi.stubEnv("QSTASH_LEGACY_NEXT_SIGNING_KEY", next);
      const { qstash, firebaseAdmin } = await cards();
      expect(qstash.subChecks.find((s) => s.label === LEGACY_LABEL)?.status).toBe("partial");
      expect(qstash.status).toBe("partial");
      expect(firebaseAdmin.subChecks.map((s) => s.label)).not.toContain(LEGACY_LABEL);
      expect(firebaseAdmin.status).toBe("ok");
    }
  });
});
