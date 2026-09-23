import { beforeEach, describe, expect, it, vi } from "vitest";
import { SA, post, resetBookingHarness, seedPage, slot } from "@/test/booking-harness";

/**
 * `page.redirectUrl` is validated https-only at write time
 * (`lib/booking/validation.ts` `validateRedirectUrl`), but this route reads
 * it back and hands it to the browser regardless — a legacy doc, or any
 * future write path that skips that validator, must not turn into a
 * `javascript:` redirect served to a booker. `new URL()` alone doesn't
 * reject a `javascript:` scheme, it parses it fine, so the route needs its
 * own read-time check.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/booking/contact-reconcile", async () => (await h()).bookingMocks.reconcile());

const { POST } = await import("./route");

const book = (slug: string) =>
  POST(post({ name: "V", email: "v@example.com", phone: "+27600000000", slot: slot("09:00", "09:30") }), {
    params: Promise.resolve({ saId: SA, slug }),
  });

beforeEach(resetBookingHarness);

describe("book route redirectUrl", () => {
  it("returns a safe https redirectUrl", async () => {
    seedPage("p", { redirectUrl: "https://example.com/thanks" });
    const res = await book("p");
    const body = (await res.json()) as { redirectUrl: string | null };
    expect(res.status).toBe(200);
    expect(body.redirectUrl).toMatch(/^https:\/\/example\.com\/thanks/);
  });

  it("never returns a javascript: redirectUrl even if stored", async () => {
    // Bypasses the write-time validator on purpose — simulates a legacy doc.
    seedPage("p", { redirectUrl: "javascript:alert(document.cookie)" });
    const res = await book("p");
    const body = (await res.json()) as { redirectUrl: string | null };
    expect(res.status).toBe(200);
    expect(body.redirectUrl).toBeNull();
  });
});
