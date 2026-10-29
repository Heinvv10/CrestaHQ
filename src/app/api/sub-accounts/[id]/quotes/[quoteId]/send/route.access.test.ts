import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * Behaviour-pinning tests for the quote/invoice SEND route — the guards that
 * refuse before anything is sent: Resend configuration, the quote's existence
 * and tenancy, territory scoping, and the recipient's email.
 *
 * Written BEFORE the send logic was extracted into `sendQuoteServerSide()`,
 * precisely so the extraction could be proven to change nothing observable.
 * Every status code and every error STRING is asserted verbatim.
 *
 * Shared fakes live in ./send-test-harness. Siblings:
 *   route.payment-rails.test.ts — invoice rails + the PayPal link
 *   route.send.test.ts          — token, send, lifecycle write, side-effects
 */

vi.mock("firebase-admin/firestore", async () =>
  (await import("./send-test-harness")).firestoreMock(),
);
vi.mock("@/lib/firebase/admin", async () =>
  (await import("./send-test-harness")).adminMock(),
);
vi.mock("@/lib/auth/require-tenancy", async () =>
  (await import("./send-test-harness")).tenancyMock(),
);
vi.mock("@/lib/auth/territory-filter", async () =>
  (await import("./send-test-harness")).territoryMock(),
);
vi.mock("@/lib/comms/resend", async () =>
  (await import("./send-test-harness")).resendMock(),
);
vi.mock("@/lib/quotes/token", async () =>
  (await import("./send-test-harness")).tokenMock(),
);
vi.mock("@/lib/quotes/email", async () =>
  (await import("./send-test-harness")).emailMock(),
);
vi.mock("@/lib/quotes/lifecycle", async () =>
  (await import("./send-test-harness")).lifecycleMock(),
);

import {
  CONTACT_ID,
  SUB_ID,
  DENIAL_MESSAGE,
  baseQuote,
  callJson,
  resetHarness,
  sendEmail,
  state,
  territoryDenialForContact,
} from "./send-test-harness";
import { POST } from "./route";

const call = () => callJson(POST);

beforeEach(resetHarness);

describe("membership", () => {
  it("returns the auth refusal verbatim and never reaches Firestore", async () => {
    // The route's only job before delegating is membership. If that check is
    // ever removed, any signed-in user could send another workspace's quotes
    // that happen to pass the service's own tenancy check.
    const { NextResponse } = await import("next/server");
    state.accessResult = NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );

    const { status, body } = await call();
    expect(status).toBe(401);
    expect(body.error).toBe("Unauthorized");
    expect(state.docReads).toEqual([]);
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(state.quoteUpdates).toHaveLength(0);
  });
});

describe("pre-flight guards", () => {
  it("503s when Resend isn't configured, before touching Firestore", async () => {
    state.emailConfigured = false;
    const { status, body } = await call();
    expect(status).toBe(503);
    expect(body.error).toBe(
      "Email isn't configured for this sub-account — connect an email provider in Settings → Messaging.",
    );
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(state.quoteUpdates).toHaveLength(0);
  });

  it("404s an unknown quote", async () => {
    state.quoteDoc = null;
    const { status, body } = await call();
    expect(status).toBe(404);
    expect(body.error).toBe("Quote not found");
  });

  it("403s a quote belonging to another sub-account", async () => {
    state.quoteDoc = baseQuote({ subAccountId: "other-sub" });
    const { status, body } = await call();
    expect(status).toBe(403);
    expect(body.error).toBe("Quote belongs to a different sub-account");
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("403s when the territory gate denies, without sending", async () => {
    state.territoryDenies = true;
    const { status, body } = await call();
    expect(status).toBe(403);
    expect(body.error).toBe(DENIAL_MESSAGE);
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(state.quoteUpdates).toHaveLength(0);
  });

  it("scopes the territory check against the quote's CONTACT id", async () => {
    // Handing the check the wrong id (the quote's own id, say) would look
    // identical from the outside on the allow path while silently scoping a
    // collaborator against a record that does not exist.
    await call();
    expect(territoryDenialForContact).toHaveBeenCalledTimes(1);
    expect(territoryDenialForContact).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "uid1", subAccountId: SUB_ID }),
      CONTACT_ID,
    );
  });

  it("409s a signed quote, sending nothing: a re-send would rotate its link over the signature", async () => {
    state.quoteDoc = baseQuote({ status: "accepted", signature: { signerName: "Jane Doe", documentHash: "a".repeat(64) } });
    const { status, body } = await call();
    expect(status).toBe(409);
    expect(body.error).toBe(
      "This quote has been signed and can't be re-sent. Convert it to an invoice to request payment, or create a new quote.",
    );
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(state.quoteUpdates).toHaveLength(0);
  });

  it("still sends an invoice converted from a signed quote", async () => {
    state.quoteDoc = baseQuote({ kind: "invoice", status: "draft", signature: { signerName: "Jane Doe", documentHash: "a".repeat(64) } });
    const { status } = await call();
    expect(status).not.toBe(409);
  });

  it("404s when the recipient contact is gone", async () => {
    state.contactDoc = null;
    const { status, body } = await call();
    expect(status).toBe(404);
    expect(body.error).toBe("Recipient contact no longer exists");
  });

  it("404s a quote whose contact lives in another sub-account, sending nothing", async () => {
    // A quote doc can be written client-side naming any contact id. The send
    // must not email — or report as `sentTo` — another tenant's contact.
    state.contactDoc = { email: "someone-else@example.com", name: "X", subAccountId: "other-sub" };
    const { status, body } = await call();
    expect(status).toBe(404);
    expect(body.error).toBe("Recipient contact no longer exists");
    expect(JSON.stringify(body)).not.toContain("someone-else@example.com");
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(state.quoteUpdates).toHaveLength(0);
  });

  it("400s when the contact has no email", async () => {
    state.contactDoc = { name: "Jane Doe", subAccountId: SUB_ID };
    const { status, body } = await call();
    expect(status).toBe(400);
    expect(body.error).toBe(
      "Contact has no email address — add one to their profile, then re-send.",
    );
  });

  it("treats a whitespace-only email as missing", async () => {
    state.contactDoc = { email: "   ", name: "Jane Doe", subAccountId: SUB_ID };
    const { status } = await call();
    expect(status).toBe(400);
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
