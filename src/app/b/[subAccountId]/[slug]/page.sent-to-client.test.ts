import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { stringsSentToClient } from "@/test/sent-to-client";

/**
 * What the public booking pages (/b, the embed, /e) hand to their client
 * component. The stored booking-page doc is given to it as props, and Next
 * writes every prop into the response for hydration — so a stored style
 * value that is not what the app writes must be dropped by the server page,
 * not merely left unrendered by the component.
 *
 * CI found this the hard way: with only the in-component check, a hostile
 * `accentColor` was absent from the markup yet present twice in the served
 * HTML, inside the inline <script> carrying the `page` and `branding` props.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: async () => undefined }));

const { SA, resetBookingHarness, seedEvent, seedPage } = await h();
const { default: PublicBookingPage } = await import("./page");
const { default: EmbedBookingPage } = await import("@/app/(embed)/embed/booking/[subAccountId]/[slug]/page");
const { default: PublicEventPage } = await import("@/app/e/[token]/page");
const { issueEventToken } = await import("@/lib/booking/event-token");

type Props = { page?: Record<string, unknown>; branding: Record<string, unknown> };
const params = { params: Promise.resolve({ subAccountId: SA, slug: "p" }) };

/** Each public page's returned element, for a booking page stored with `stored`. */
const PAGES: Record<string, (stored: Record<string, unknown>) => Promise<ReactElement<Props>>> = {
  "/b": async (stored) => {
    seedPage("p", stored as never);
    return (await PublicBookingPage(params)) as ReactElement<Props>;
  },
  "the embed": async (stored) => {
    seedPage("p", stored as never);
    return (await EmbedBookingPage(params)) as ReactElement<Props>;
  },
  "/e": async (stored) => {
    seedPage("p", stored as never);
    const issued = issueEventToken("e1");
    seedEvent("e1", "10:00", "10:30", { title: "Intro", bookingPageSlug: "p", publicTokenHash: issued.hash });
    return (await PublicEventPage({ params: Promise.resolve({ token: issued.token }) })) as ReactElement<Props>;
  },
};

const HOSTILE = [
  ["extra CSS declarations", "red;position:fixed;inset:0;background:url(https://evil.example/x)"],
  ["a hex followed by more CSS", "#FF5500;background:url(https://evil.example/x)"],
  ["markup", '"><script src="https://evil.example/x"></script>'],
  ["a script-closing sequence", "</script><script>fetch('https://evil.example/x')</script>"],
] as const;

beforeEach(() => resetBookingHarness());
afterEach(() => vi.useRealTimers());

describe.each(Object.keys(PAGES))("what %s sends to the browser", (name) => {
  const open = PAGES[name];

  it("includes the page's own fields (so this test does see the props)", async () => {
    const sent = stringsSentToClient(await open({ name: "Strategy call" }));
    expect(sent).toContain("Fixture");
    expect(sent).toContain("accentColor");
  });

  it.each(HOSTILE)("drops a stored accent that is %s", async (_label, accentColor) => {
    const el = await open({ accentColor });
    expect(stringsSentToClient(el).filter((s) => s.includes("evil.example"))).toEqual([]);
    expect(el.props.branding.accentColor).toBeNull();
    if (el.props.page) expect(el.props.page.accentColor).toBeNull();
  });

  it.each(HOSTILE)("drops a stored preset that is %s", async (_label, themePreset) => {
    const el = await open({ themePreset });
    expect(stringsSentToClient(el).filter((s) => s.includes("evil.example"))).toEqual([]);
    if (el.props.page) expect(el.props.page.themePreset).toBeNull();
  });

  it.each([["#FF5500"], ["#F50"]])("still sends a real accent (%s)", async (accentColor) => {
    const el = await open({ accentColor });
    expect(el.props.branding.accentColor).toBe(accentColor);
    if (el.props.page) expect(el.props.page.accentColor).toBe(accentColor);
  });

  it("still sends a real preset, and none for a page stored without one", async () => {
    const styled = await open({ themePreset: "ocean" });
    if (styled.props.page) expect(styled.props.page.themePreset).toBe("ocean");
    const plain = await open({});
    if (plain.props.page) expect(plain.props.page.themePreset).toBeNull();
    for (const stored of ["bogus", "constructor", "__proto__", 42, { id: "ocean" }]) {
      const el = await open({ themePreset: stored });
      if (el.props.page) expect(el.props.page.themePreset, JSON.stringify(stored)).toBeNull();
    }
  });
});
