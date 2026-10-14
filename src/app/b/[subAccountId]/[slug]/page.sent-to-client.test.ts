import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { stringsSentToClient } from "@/test/sent-to-client";

/**
 * What the public booking pages (/b, the embed, /e) hand to their client
 * component. Next writes every prop into the response for hydration, so
 * whatever is handed over is public, rendered or not.
 *
 * Two findings shaped this file. CI found a hostile stored `accentColor`
 * absent from the markup yet present twice in the served HTML, inside the
 * inline <script> carrying the props. And the pages used to spread the whole
 * stored booking-page doc into those props, so a live page's source held its
 * creator's uid, its tenancy ids and — once one was set — its meeting link.
 * The loaders now send an allow-list; these tests pin its exact keys and
 * check that nothing else from a fully populated doc gets through.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: async () => undefined }));

const { SA, mem, resetBookingHarness, seedEvent, seedPage } = await h();
const { default: PublicBookingPage } = await import("./page");
const { default: EmbedBookingPage } = await import("@/app/(embed)/embed/booking/[subAccountId]/[slug]/page");
const { default: PublicEventPage } = await import("@/app/e/[token]/page");
const { issueEventToken } = await import("@/lib/booking/event-token");

type Props = { page?: Record<string, unknown>; branding: Record<string, unknown> } & Record<string, unknown>;
const params = { params: Promise.resolve({ subAccountId: SA, slug: "p" }) };
let eventToken = "";

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
    eventToken = issued.token;
    seedEvent("e1", "10:00", "10:30", { ...EVENT_SECRETS, title: "Intro", bookingPageSlug: "p", publicTokenHash: issued.hash });
    return (await PublicEventPage({ params: Promise.resolve({ token: issued.token }) })) as ReactElement<Props>;
  },
};

const PAGE_KEYS = ["description", "durationMinutes", "intakeFields", "isServicePage", "name", "payment", "services", "slug", "themePreset", "timezone", "visibleDays"];
const BRANDING_KEYS = ["accentColor", "logoUrl", "name"];
/** The exact props each page gives its client component. */
const PROP_KEYS: Record<string, string[]> = {
  "/b": ["branding", "page", "subAccountId"],
  "the embed": ["branding", "embedded", "page", "subAccountId"],
  "/e": [
    "bookingPageStatus", "branding", "cardPayEnabled", "durationMinutes", "endAt", "eventId", "pageName", "pageSlug",
    "paymentAmount", "paymentCurrency", "paymentLinkUrl", "startAt", "status", "subAccountId", "timezone", "title", "token",
  ],
};

/**
 * A booking page with every field a real one can carry, each private value a
 * recognisable sentinel. None of these may be handed to the client.
 */
const PRIVATE_VALUES = {
  createdByUid: "uid-SENTINEL-creator",
  agencyId: "agency-SENTINEL",
  territoryId: "territory-SENTINEL",
  defaultTerritoryId: "default-territory-SENTINEL",
  meetingUrl: "https://meet.example/SENTINEL-room",
  confirmationMessage: "SENTINEL thanks, the door code is 4471",
  redirectUrl: "https://example.com/SENTINEL-thanks",
  ghlCalendarId: "ghl-SENTINEL-calendar",
  ghlCalendarJson: { apiKey: "ghl-SENTINEL-json" },
  migratedFrom: "ghl-SENTINEL-source",
  migrationReviewRequired: true,
  lastAgentEditKey: "agent-SENTINEL-key",
  lastAgentEditAt: "agent-SENTINEL-at",
  lastAgentEditTool: "agent-SENTINEL-tool",
  hosts: [{ uid: "uid-SENTINEL-host", name: "SENTINEL Host", priority: 2 }],
  allowHostSelection: true,
  calendarType: "round_robin",
  distribution: "availability",
  workingHours: [{ dayOfWeek: 1, startMinute: 540, endMinute: 721 }],
  dateOverrides: [{ date: "2026-12-25", ranges: [] }],
  reminderOffsetsMinutes: [1439],
  remindersEnabled: true,
  minNoticeHours: 7,
  maxPerDay: 13,
  bufferMinutes: 17,
};
/** Key names that must appear nowhere in what is sent, however deeply nested. */
const PRIVATE_KEYS = [...Object.keys(PRIVATE_VALUES), "createdAt", "updatedAt", "uid", "priority", "payeeAccount", "internalNote", "internalCost"];
/** The same for the event doc /e reads. */
const EVENT_SECRETS = {
  createdByUid: "uid-SENTINEL-event-creator",
  contactId: "contact-SENTINEL",
  assignedToUid: "uid-SENTINEL-assignee",
  assignedToName: "SENTINEL Assignee",
  meetingUrl: "https://meet.example/SENTINEL-event-room",
  notes: "SENTINEL internal note",
  attendeeEmail: "sentinel@example.com",
};
const STORED = {
  ...PRIVATE_VALUES,
  name: "Strategy call",
  description: "Thirty minutes.",
  payment: { amount: 50, currency: "USD", description: "Deposit", holdHours: 24, payeeAccount: "acct-SENTINEL-payee" },
  intakeFields: [{ id: "q1", label: "Topic", type: "select", required: true, options: ["A", "B"], internalNote: "note-SENTINEL-field" }],
  logoUrl: "https://cdn.example/logo.png",
  accentColor: "#FF5500",
  themePreset: "ocean",
};

const HOSTILE = [
  ["extra CSS declarations", "red;position:fixed;inset:0;background:url(https://evil.example/x)"],
  ["a hex followed by more CSS", "#FF5500;background:url(https://evil.example/x)"],
  ["markup", '"><script src="https://evil.example/x"></script>'],
  ["a script-closing sequence", "</script><script>fetch('https://evil.example/x')</script>"],
] as const;

beforeEach(() => {
  resetBookingHarness();
  mem.seed(`subAccounts/${SA}`, {
    agencyId: "agency-SENTINEL", name: "Fixture", logoUrl: null, ownerUid: "uid-SENTINEL-owner", twilioConfig: { accountSid: "AC-SENTINEL" },
    paymentsEnabledByAgency: true, stripeConnectionMeta: { ready: true, accountId: "acct-SENTINEL-stripe" },
  });
});
afterEach(() => vi.useRealTimers());

describe.each(Object.keys(PAGES))("what %s sends to the browser", (name) => {
  const open = PAGES[name];

  it("hands its client component exactly these props, and nothing else", async () => {
    const el = await open(STORED);
    expect(Object.keys(el.props).sort()).toEqual(PROP_KEYS[name]);
    expect(Object.keys(el.props.branding).sort()).toEqual(BRANDING_KEYS);
    expect(el.props.branding).toEqual({ name: "Fixture", logoUrl: "https://cdn.example/logo.png", accentColor: "#FF5500" });
    if (name === "/e") return;
    expect(Object.keys(el.props.page!).sort()).toEqual(PAGE_KEYS);
    expect(el.props.page).toEqual({
      slug: "p",
      name: "Strategy call",
      description: "Thirty minutes.",
      durationMinutes: 30,
      timezone: "UTC",
      visibleDays: 14,
      isServicePage: false,
      services: [],
      intakeFields: [{ id: "q1", label: "Topic", type: "select", required: true, options: ["A", "B"] }],
      payment: { amount: 50, currency: "USD", description: "Deposit", holdHours: 24 },
      themePreset: "ocean",
    });
  });

  it("sends none of a fully populated doc's private values, by value or by key name", async () => {
    const sent = stringsSentToClient(await open(STORED));
    // This walk does see the props: the public ones are there.
    expect(sent).toContain("Fixture");
    expect(sent).toContain("branding");
    expect(sent.filter((s) => s.includes("SENTINEL"))).toEqual([]);
    expect(PRIVATE_KEYS.filter((k) => sent.includes(k))).toEqual([]);
  });

  it("sends a service page its services, and no other page any", async () => {
    if (name === "/e") return;
    const services = [{ id: "s1", name: "Cut", durationMinutes: 30, description: null, internalCost: "cost-SENTINEL" }];
    const service = await open({ calendarType: "service", services });
    expect(service.props.page).toMatchObject({ isServicePage: true, services: [{ id: "s1", name: "Cut", durationMinutes: 30, description: null }] });
    expect(stringsSentToClient(service).filter((s) => s.includes("SENTINEL"))).toEqual([]);
    const other = await open({ calendarType: "round_robin", services });
    expect(other.props.page).toMatchObject({ isServicePage: false, services: [] });
  });

  it("uses the canonical route slug instead of a hostile stored slug", async () => {
    if (name === "/e") return;
    const el = await open({ slug: "../../events/slug-SENTINEL/cancel?" });
    expect(el.props.page?.slug).toBe("p");
    expect(stringsSentToClient(el).filter((s) => s.includes("slug-SENTINEL"))).toEqual([]);
  });

  it("drops malformed stored public fields instead of serialising nested values or throwing", async () => {
    if (name === "/e") return;
    const el = await open({
      name: { nested: "name-SENTINEL" },
      description: { nested: "description-SENTINEL" },
      durationMinutes: Number.NaN,
      timezone: { nested: "timezone-SENTINEL" },
      visibleDays: Number.POSITIVE_INFINITY,
      calendarType: "service",
      services: [
        { id: "valid", name: "Valid", durationMinutes: 45, description: null, nested: "service-SENTINEL" },
        { id: "invalid", name: { nested: "invalid-service-SENTINEL" }, durationMinutes: 30 },
      ],
      intakeFields: [
        { id: "valid", label: "Choose", type: "select", required: true, options: ["Safe", { nested: "option-SENTINEL" }] },
        { id: "invalid", label: "Invalid", type: { nested: "type-SENTINEL" }, required: false },
      ],
      payment: { amount: { nested: "amount-SENTINEL" }, currency: "USD", description: null, holdHours: 24 },
    });
    expect(el.props.page).toMatchObject({
      name: "",
      description: "",
      durationMinutes: 30,
      timezone: "UTC",
      visibleDays: 14,
      services: [{ id: "valid", name: "Valid", durationMinutes: 45, description: null }],
      intakeFields: [{ id: "valid", label: "Choose", type: "select", required: true, options: ["Safe"] }],
      payment: null,
    });
    expect(stringsSentToClient(el).filter((s) => s.includes("SENTINEL"))).toEqual([]);
  });

  it("defaults non-array services and intake fields without throwing", async () => {
    if (name === "/e") return;
    const el = await open({ calendarType: "service", services: { nested: "services-SENTINEL" }, intakeFields: { nested: "fields-SENTINEL" } });
    expect(el.props.page).toMatchObject({ services: [], intakeFields: [] });
    expect(stringsSentToClient(el).filter((s) => s.includes("SENTINEL"))).toEqual([]);
  });

  it.each(HOSTILE)("drops a stored accent that is %s", async (_label, accentColor) => {
    const el = await open({ accentColor });
    expect(stringsSentToClient(el).filter((s) => s.includes("evil.example"))).toEqual([]);
    expect(el.props.branding.accentColor).toBeNull();
  });

  it.each(HOSTILE)("drops a stored preset that is %s", async (_label, themePreset) => {
    const el = await open({ themePreset });
    expect(stringsSentToClient(el).filter((s) => s.includes("evil.example"))).toEqual([]);
    if (el.props.page) expect(el.props.page.themePreset).toBeNull();
  });

  it.each([
    ["a javascript: URL", "javascript:fetch('https://evil.example/x')"],
    ["a data: URL", "data:text/html,<script src=https://evil.example/x></script>"],
    ["not a URL", "evil.example/x"],
    ["a non-string", ["https://evil.example/x"]],
  ])("drops a stored logo that is %s", async (_label, logoUrl) => {
    const el = await open({ logoUrl });
    expect(stringsSentToClient(el).filter((s) => s.includes("evil.example"))).toEqual([]);
    expect(el.props.branding.logoUrl).toBeNull();
  });

  it.each([["#FF5500"], ["#F50"]])("still sends a real accent (%s)", async (accentColor) => {
    expect((await open({ accentColor })).props.branding.accentColor).toBe(accentColor);
  });

  it("falls back to the sub-account's logo, http or https, when the page has none", async () => {
    for (const logoUrl of ["https://cdn.example/sub.png", "http://cdn.example/sub.png"]) {
      mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Fixture", logoUrl });
      expect((await open({})).props.branding.logoUrl).toBe(logoUrl);
    }
  });

  it("still sends a real preset, and none for a page stored without one or with an unknown one", async () => {
    if (name === "/e") return;
    expect((await open({ themePreset: "ocean" })).props.page!.themePreset).toBe("ocean");
    expect((await open({})).props.page!.themePreset).toBeNull();
    for (const stored of ["bogus", "constructor", "__proto__", 42, { id: "ocean" }]) {
      expect((await open({ themePreset: stored })).props.page!.themePreset, JSON.stringify(stored)).toBeNull();
    }
  });
});

describe("/e", () => {
  it("sends the manage token it was opened with, and the event's id for its own API calls", async () => {
    const el = await PAGES["/e"](STORED);
    expect(el.props.token).toBe(eventToken);
    expect(el.props.eventId).toBe("e1");
    expect(el.props.pageSlug).toBe("p");
  });

  it("normalises every malformed stored event-view value before it reaches the client", async () => {
    seedPage("p", {
      name: { nested: "page-name-SENTINEL" },
      status: { nested: "page-status-SENTINEL" },
      timezone: "timezone-SENTINEL",
      durationMinutes: { nested: "duration-SENTINEL" },
    } as never);
    const issued = issueEventToken("e1");
    seedEvent("e1", "10:00", "10:30", {
      title: { nested: "title-SENTINEL" },
      status: { nested: "event-status-SENTINEL" },
      serviceName: { nested: "service-SENTINEL" },
      bookingPageSlug: "p",
      publicTokenHash: issued.hash,
      paymentLinkUrl: "https://evil-SENTINEL.example/pay",
      paymentAmount: { nested: "amount-SENTINEL" },
      paymentCurrency: { nested: "currency-SENTINEL" },
    });

    const el = (await PublicEventPage({ params: Promise.resolve({ token: issued.token }) })) as ReactElement<Props>;
    expect(el.props).toMatchObject({
      eventId: "e1",
      status: "scheduled",
      title: "Meeting",
      pageName: "Meeting",
      pageSlug: "p",
      bookingPageStatus: "published",
      timezone: "UTC",
      durationMinutes: 30,
      paymentLinkUrl: null,
      paymentAmount: null,
      paymentCurrency: null,
    });
    expect(stringsSentToClient(el).filter((s) => s.includes("SENTINEL"))).toEqual([]);
  });

  it("keeps a generated PayPal.me payment URL", async () => {
    seedPage("p");
    const issued = issueEventToken("e1");
    seedEvent("e1", "10:00", "10:30", {
      bookingPageSlug: "p",
      publicTokenHash: issued.hash,
      paymentLinkUrl: "https://paypal.me/acme/50USD",
    });
    const el = (await PublicEventPage({ params: Promise.resolve({ token: issued.token }) })) as ReactElement<Props>;
    expect(el.props.paymentLinkUrl).toBe("https://paypal.me/acme/50USD");
  });
});
