import { createHash } from "node:crypto";
import { vi } from "vitest";
import { createMemoryFirestore } from "./memory-firestore";

/**
 * Seam fixtures for the email suppression tests (W4 PR1): each send path runs
 * through the REAL `sendEmail` and the real suppression lookup over an
 * in-memory Firestore. Only the SMTP wire, conversation archiving and usage
 * metering are stubbed, in the test file:
 *
 *   const s = () => import("@/test/email-suppression-seam");
 *   vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
 *   vi.mock("@/lib/comms/smtp", async () => (await s()).seamMocks.smtp());
 *   …same for email-conversations / usage-meter
 *
 * No app imports here: the mock factories load this module.
 */

export const mem = createMemoryFirestore();
export const SA = "sa1";
export const AGENCY = "ag1";

/** The SMTP wire. A suppressed recipient must never reach it. */
export const smtpSend = vi.fn(async (_c: unknown, _m: { to: string }) => ({
  id: "<sent@tenant.test>",
}));

/** A sub-account whose own SMTP is verified — `emailIsConfigured` is true. */
export const SMTP_SUB = {
  agencyId: AGENCY,
  name: "Fixture Co",
  emailProvider: "smtp",
  smtpConfig: {
    host: "smtp.tenant.test",
    port: 465,
    secure: true,
    username: "sender@tenant.test",
    fromEmail: "sender@tenant.test",
    fromName: "Fixture",
    verifiedAt: "2026-09-01T00:00:00.000Z",
  },
};

export const seamMocks = {
  admin: () => ({ getAdminDb: () => mem.db }),
  // The real address validation stays; only the connection and the wire are faked.
  smtp: async (original: () => Promise<Record<string, unknown>>) => ({
    ...(await original()),
    getSmtpConnection: async () => ({ fromEmail: "sender@tenant.test" }),
    sendSmtpEmail: (c: unknown, m: { to: string }) => smtpSend(c, m),
  }),
  conversations: () => ({
    recordEmailMessage: async () => ({ inserted: true, contactId: "c1" }),
  }),
  usage: async (original: () => Promise<Record<string, unknown>>) => ({
    ...(await original()),
    recordUsage: async () => undefined,
    checkQuota: async () => ({ allowed: true }),
  }),
};

/** Resets the store and the wire; seeds the SMTP sub-account. */
export function resetSeam(): void {
  mem.clear();
  smtpSend.mockClear();
  mem.seed(`subAccounts/${SA}`, SMTP_SUB);
}

/**
 * The suppression doc for `email`, as `[path, data]` — for a test whose
 * Firestore is another harness's store. The doc id is hashed HERE, not by the
 * module under test, so a lookup that drifts from the stored path goes red
 * instead of following along.
 */
export function suppressionSeed(
  email: string,
  subAccountId = SA,
  reason: "hard_bounce" | "complaint" | "manual" = "hard_bounce"
): [string, Record<string, unknown>] {
  const normalized = email.trim().toLowerCase();
  const id = createHash("sha256").update(normalized).digest("hex");
  return [
    `subAccounts/${subAccountId}/emailSuppressions/${id}`,
    { agencyId: AGENCY, subAccountId, createdByUid: "u1", email: normalized, reason, note: null, createdAt: new Date() },
  ];
}

/** Suppresses `email` for `subAccountId` in this seam's store. */
export function suppress(...args: Parameters<typeof suppressionSeed>): void {
  mem.seed(...suppressionSeed(...args));
}

/** Every address the SMTP wire was handed. */
export const wireRecipients = (): string[] => smtpSend.mock.calls.map(([, m]) => m.to);
