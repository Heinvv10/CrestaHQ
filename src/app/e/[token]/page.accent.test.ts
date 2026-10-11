import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cloneElement, type ReactElement } from "react";

/**
 * The reschedule/cancel page takes its accent from the booking page. Through
 * the real /e server page: a stored hex colour is used, and anything else is
 * ignored instead of being written into a style attribute.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: async () => undefined }));

const { resetBookingHarness, seedEvent, seedPage } = await h();
const { default: PublicEventPage } = await import("./page");
const { issueEventToken } = await import("@/lib/booking/event-token");

const LOGO_CHIP = /<span class="mx-auto flex h-12 w-12 [^"]*" style="([^"]*)">/;

/** The page as the attendee opens it, for a booking page storing `accentColor`. */
async function open(accentColor: unknown): Promise<string> {
  seedPage("p", { accentColor } as never);
  const issued = issueEventToken("e1");
  seedEvent("e1", "10:00", "10:30", { title: "Intro", bookingPageSlug: "p", publicTokenHash: issued.hash });
  return renderToStaticMarkup((await PublicEventPage({ params: Promise.resolve({ token: issued.token }) })) as ReactElement);
}

beforeEach(() => resetBookingHarness());
afterEach(() => vi.useRealTimers());

/**
 * The server page drops a bad stored accent before the view sees it; this
 * hands the view one directly, as a caller that skipped the page would.
 */
async function viewGiven(accentColor: unknown): Promise<string> {
  seedPage("p");
  const issued = issueEventToken("e1");
  seedEvent("e1", "10:00", "10:30", { title: "Intro", bookingPageSlug: "p", publicTokenHash: issued.hash });
  const el = (await PublicEventPage({ params: Promise.resolve({ token: issued.token }) })) as ReactElement<{ branding: Record<string, unknown> }>;
  return renderToStaticMarkup(cloneElement(el, { branding: { ...el.props.branding, accentColor } }));
}

describe("the view's own check, given an accent the server page would have dropped", () => {
  it.each([
    ["extra CSS declarations", "red;position:fixed;inset:0;background:url(https://evil.example/x)"],
    ["a hex followed by more CSS", "#FF5500;background:url(https://evil.example/x)"],
    ["a non-string", ["#FF5500"]],
  ])("ignores an accent that is %s", async (_label, accent) => {
    const html = await viewGiven(accent);
    expect(html).not.toContain("evil.example");
    expect(html).toBe(await viewGiven(null));
  });

  it("uses a real accent", async () => {
    expect((await viewGiven("#F50")).match(LOGO_CHIP)?.[1]).toBe("background-color:#F50");
  });
});

describe("the accent on the reschedule/cancel page", () => {
  it.each([["#FF5500"], ["#F50"]])("uses a stored hex accent (%s)", async (accent) => {
    const html = await open(accent);
    expect(html.match(LOGO_CHIP)?.[1]).toBe(`background-color:${accent}`);
  });

  it.each([
    ["extra CSS declarations", "red;position:fixed;inset:0;background:url(https://evil.example/x)"],
    ["a hex followed by more CSS", "#FF5500;background:url(https://evil.example/x)"],
    ["a CSS function", "url(https://evil.example/x)"],
    ["markup", '"><script src="https://evil.example/x"></script>'],
    ["a colour name", "red"],
    ["a non-string", ["#FF5500"]],
  ])("ignores a stored accent that is %s", async (_label, accent) => {
    const plain = await open(null);
    expect(plain.match(LOGO_CHIP)?.[1]).toBe("background-color:#0F766E");
    const html = await open(accent);
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("position:fixed");
    expect(html).toBe(plain);
  });
});
