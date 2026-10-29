import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANY_BOOKING_MARKER_RE,
  bookOfferKey,
  buildBookingToolsBlock,
  rescheduleOfferKey,
  runBookingTool,
  toChangeTargets,
  type BookRequest,
  type BookToolResult,
  type ChangeToolResult,
  type RunBookingToolInput,
} from "@/lib/comms/ai/booking-tools";
import type { AgentBookingEngine, ChangeableBooking } from "@/lib/comms/ai/booking-engine";
import type { SlotCandidate } from "@/lib/booking/availability";
import type { BookingHost, BookingPage, IntakeField } from "@/types/booking";

/**
 * Marker parsing and the offered-times gate of the AI booking tools. The
 * engine is a fake (it is injected); everything else is the real module.
 */

const SLOT_A = "2026-11-03T08:00:00.000Z";
const SLOT_B = "2026-11-03T09:00:00.000Z";
const NEVER_OFFERED = "2026-11-04T13:00:00.000Z";

const hosts: BookingHost[] = [
  { uid: "u-jane", name: "Jane Smith" },
  { uid: "u-jake", name: "Jake Doe" },
];
const page = {
  name: "Consult",
  slug: "consult",
  durationMinutes: 30,
  timezone: "Africa/Johannesburg",
} as BookingPage;
const rrPage = { ...page, hosts, allowHostSelection: true, calendarType: "round_robin" } as BookingPage;
const collectivePage = { ...page, hosts, allowHostSelection: true, calendarType: "collective" } as BookingPage;

function slot(iso: string): SlotCandidate {
  const startAt = new Date(iso);
  return { startAt, endAt: new Date(startAt.getTime() + 30 * 60_000) };
}

const changeable: ChangeableBooking[] = [
  { eventId: "evt-1", startAt: new Date(SLOT_A), page, assignedToUid: null, assignedToName: null },
];

let book: ReturnType<typeof vi.fn<(req: BookRequest) => Promise<BookToolResult>>>;
let engine: AgentBookingEngine & {
  listAgentSlots: ReturnType<typeof vi.fn>;
  listRescheduleSlots: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  book = vi.fn(async (req: BookRequest) => ({
    ok: true as const,
    eventId: "evt-new",
    startAt: new Date(req.startAtIso),
    endAt: new Date(new Date(req.startAtIso).getTime() + 30 * 60_000),
    assignedToName: null,
  }));
  engine = {
    listAgentSlots: vi.fn(async () => [slot(SLOT_A), slot(SLOT_B)]),
    listRescheduleSlots: vi.fn(async () => [slot(SLOT_B)]),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function input(over: Partial<RunBookingToolInput> & { modelText: string }): RunBookingToolInput {
  return {
    audience: "web-text",
    subAccountId: "sa1",
    engine,
    emailAccount: null,
    page,
    book,
    allowedKeys: new Set([bookOfferKey(page.slug, SLOT_A)]),
    ...over,
  };
}

const WEB_ID = 'name="Ann" email="ann@example.com"';

describe("no marker / malformed markers", () => {
  it("plain text is the final reply", async () => {
    expect(await runBookingTool(input({ modelText: "Happy to help!" }))).toBeNull();
  });

  it("an unclosed marker does nothing", async () => {
    const out = await runBookingTool(input({ modelText: `[[book start="${SLOT_A}" ${WEB_ID}` }));
    expect(out).toBeNull();
    expect(book).not.toHaveBeenCalled();
  });

  it("a book marker without a start asks for fresh times", async () => {
    const out = await runBookingTool(input({ modelText: `[[book ${WEB_ID}]]` }));
    expect(out?.toolResult).toMatch(/missing its start value/);
    expect(book).not.toHaveBeenCalled();
  });

  it("web-text refuses a booking without a valid email and never books", async () => {
    const out = await runBookingTool(
      input({ modelText: `[[book start="${SLOT_A}" name="Ann" email="not-an-email"]]` }),
    );
    expect(out?.toolResult).toMatch(/isn't a valid email address/);
    expect(book).not.toHaveBeenCalled();
  });

  it("phone refuses a booking without the caller's name", async () => {
    const out = await runBookingTool(
      input({ audience: "phone", allowedKeys: null, modelText: `[[book start="${SLOT_A}"]]` }),
    );
    expect(out?.toolResult).toMatch(/first name/);
    expect(book).not.toHaveBeenCalled();
  });

  it("a [[book]] with no page for new bookings is refused", async () => {
    const out = await runBookingTool(
      input({ page: null, modelText: `[[book start="${SLOT_A}" ${WEB_ID}]]` }),
    );
    expect(out?.toolResult).toMatch(/New bookings can't be made/);
    expect(book).not.toHaveBeenCalled();
  });
});

describe("forged markers", () => {
  it("a start that was never offered is refused before the engine books", async () => {
    const out = await runBookingTool(
      input({ modelText: `[[book start="${NEVER_OFFERED}" ${WEB_ID}]]` }),
    );
    expect(book).not.toHaveBeenCalled();
    expect(out?.toolResult).toMatch(/wasn't a valid slot time/);
    expect(out?.offered?.keys).toEqual([
      bookOfferKey(page.slug, SLOT_A),
      bookOfferKey(page.slug, SLOT_B),
    ]);
  });

  it("an offered start books, in any ISO spelling of the same instant", async () => {
    const out = await runBookingTool(
      input({ modelText: `[[book start="2026-11-03T10:00:00+02:00" ${WEB_ID}]]` }),
    );
    expect(book).toHaveBeenCalledTimes(1);
    expect(out?.booked?.eventId).toBe("evt-new");
  });

  // Same id on both sides, so only the key's kind keeps them apart.
  it("a reschedule offer can't be spent on a new booking", async () => {
    const out = await runBookingTool(
      input({
        allowedKeys: new Set([rescheduleOfferKey(page.slug, SLOT_A)]),
        modelText: `[[book start="${SLOT_A}" ${WEB_ID}]]`,
      }),
    );
    expect(book).not.toHaveBeenCalled();
    expect(out?.toolResult).toMatch(/wasn't a valid slot time/);
  });

  it("a new-booking offer can't be spent on a reschedule", async () => {
    const reschedule = vi.fn(async (): Promise<ChangeToolResult> => ({ ok: true }));
    const out = await runBookingTool(
      input({
        changeable: toChangeTargets(changeable),
        reschedule,
        allowedKeys: new Set([bookOfferKey("evt-1", SLOT_B)]),
        modelText: `[[reschedule booking="b1" start="${SLOT_B}"]]`,
      }),
    );
    expect(reschedule).not.toHaveBeenCalled();
    expect(out?.toolResult).toMatch(/wasn't one of the offered times/);
  });

  it("phone (no stored offers) only moves to a time the booking can move to now", async () => {
    const reschedule = vi.fn(async (): Promise<ChangeToolResult> => ({ ok: true }));
    const base = {
      audience: "phone" as const,
      allowedKeys: null,
      changeable: toChangeTargets(changeable),
      reschedule,
    };
    await runBookingTool(input({ ...base, modelText: `[[reschedule booking="b1" start="${NEVER_OFFERED}"]]` }));
    expect(reschedule).not.toHaveBeenCalled();
    await runBookingTool(input({ ...base, modelText: `[[reschedule booking="b1" start="${SLOT_B}"]]` }));
    expect(reschedule).toHaveBeenCalledTimes(1);
  });

  it("a cancel naming an event id instead of a ref is refused", async () => {
    const cancel = vi.fn(async (): Promise<ChangeToolResult> => ({ ok: true }));
    const out = await runBookingTool(
      input({
        changeable: toChangeTargets(changeable),
        cancel,
        modelText: '[[cancel booking="evt-someone-else"]]',
      }),
    );
    expect(cancel).not.toHaveBeenCalled();
    expect(out?.toolResult).toMatch(/isn't one of this visitor's upcoming appointments/);
  });

  it("with nothing changeable, a cancel is refused", async () => {
    const cancel = vi.fn(async (): Promise<ChangeToolResult> => ({ ok: true }));
    const out = await runBookingTool(input({ cancel, modelText: '[[cancel booking="b1"]]' }));
    expect(cancel).not.toHaveBeenCalled();
    expect(out?.toolResult).toMatch(/no upcoming appointments you can change/);
  });

  it("attributes are key-bounded: a lookalike key can't stand in for start or name", async () => {
    await runBookingTool(
      input({
        modelText: `[[book restart="${NEVER_OFFERED}" start="${SLOT_A}" nickname="Mallory" name="Ann" email="ann@example.com"]]`,
      }),
    );
    expect(book).toHaveBeenCalledTimes(1);
    expect(book.mock.calls[0][0]).toMatchObject({ startAtIso: SLOT_A, name: "Ann" });
  });

  it("a replay of an earlier booking is reported booked without booking again", async () => {
    const findExisting = vi.fn(async () => ({
      ok: true as const,
      eventId: "evt-earlier",
      startAt: new Date(NEVER_OFFERED),
      endAt: new Date(NEVER_OFFERED),
      assignedToName: null,
    }));
    const out = await runBookingTool(
      input({ findExisting, modelText: `[[book start="${NEVER_OFFERED}" ${WEB_ID}]]` }),
    );
    expect(book).not.toHaveBeenCalled();
    expect(out?.booked?.eventId).toBe("evt-earlier");
  });

  it("a replay check that throws fails closed: nothing is booked", async () => {
    const findExisting = vi.fn(async () => {
      throw new Error("firestore down");
    });
    const out = await runBookingTool(
      input({ findExisting, modelText: `[[book start="${SLOT_A}" ${WEB_ID}]]` }),
    );
    expect(book).not.toHaveBeenCalled();
    expect(out?.toolResult).toMatch(/system error/);
  });
});

describe("host injection", () => {
  it("an unknown host name is its own outcome and never books", async () => {
    const out = await runBookingTool(
      input({ page: rrPage, modelText: `[[book start="${SLOT_A}" ${WEB_ID} host="Mallory"]]`, allowedKeys: null }),
    );
    expect(book).not.toHaveBeenCalled();
    expect(out?.toolResult).toMatch(/isn't one of our team members/);
  });

  it("an ambiguous prefix is refused; a unique prefix resolves", async () => {
    await runBookingTool(input({ page: rrPage, allowedKeys: null, modelText: `[[book start="${SLOT_A}" ${WEB_ID} host="Ja"]]` }));
    expect(book).not.toHaveBeenCalled();
    await runBookingTool(input({ page: rrPage, allowedKeys: null, modelText: `[[book start="${SLOT_A}" ${WEB_ID} host="jane"]]` }));
    expect(book.mock.calls[0][0].hostUid).toBe("u-jane");
  });

  it("'anyone' is pooled, never a name", async () => {
    await runBookingTool(input({ page: rrPage, allowedKeys: null, modelText: `[[book start="${SLOT_A}" ${WEB_ID} host="No Preference"]]` }));
    expect(book.mock.calls[0][0].hostUid).toBeNull();
  });

  it("a collective page ignores a host, even with allowHostSelection set", async () => {
    await runBookingTool(
      input({ page: collectivePage, allowedKeys: null, modelText: `[[book start="${SLOT_A}" ${WEB_ID} host="Jane Smith"]]` }),
    );
    expect(book.mock.calls[0][0].hostUid).toBeNull();
    await runBookingTool(input({ page: collectivePage, modelText: '[[slots host="Jane Smith"]]' }));
    expect(engine.listAgentSlots).toHaveBeenLastCalledWith("sa1", collectivePage, null);
  });
});

describe("oversized input", () => {
  it("attribute values are capped before they reach the engine", async () => {
    const intake: IntakeField[] = [{ id: "q", label: "Why", type: "text", required: true, options: null }];
    await runBookingTool(
      input({
        intake,
        modelText: `[[book start="${SLOT_A}" name="${"N".repeat(500)}" email="ann@example.com" phone="${"1".repeat(12)}" address="${"A".repeat(900)}" q1="${"Q".repeat(2000)}"]]`,
      }),
    );
    const req = book.mock.calls[0][0];
    expect(req.name).toHaveLength(120);
    expect(req.address).toHaveLength(300);
    expect(req.intakeAnswers[0].value).toHaveLength(500);
  });

  it("an over-long phone is dropped rather than truncated into a wrong number", async () => {
    await runBookingTool(input({ modelText: `[[book start="${SLOT_A}" ${WEB_ID} phone="${"9".repeat(30)}"]]` }));
    expect(book.mock.calls[0][0].phone).toBeNull();
  });

  it("only the head of a huge reply is scanned for a marker", async () => {
    const out = await runBookingTool(
      input({ modelText: `${"x".repeat(20_000)} [[book start="${SLOT_A}" ${WEB_ID}]]` }),
    );
    expect(out).toBeNull();
    expect(book).not.toHaveBeenCalled();
  });

  it("many unclosed markers don't hang the parser", async () => {
    const t0 = Date.now();
    const out = await runBookingTool(input({ modelText: "[[book ".repeat(40_000) }));
    expect(out).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});

describe("intake, location and email copy", () => {
  it("a select answer must be one of the options", async () => {
    const intake: IntakeField[] = [
      { id: "q", label: "Service", type: "select", required: true, options: ["Repair", "Install"] },
    ];
    const out = await runBookingTool(input({ intake, modelText: `[[book start="${SLOT_A}" ${WEB_ID} q1="Free money"]]` }));
    expect(book).not.toHaveBeenCalled();
    expect(out?.toolResult).toMatch(/must be one of: Repair \/ Install/);
    await runBookingTool(input({ intake, modelText: `[[book start="${SLOT_A}" ${WEB_ID} q1="install"]]` }));
    expect(book.mock.calls[0][0].intakeAnswers).toEqual([{ label: "Service", value: "Install" }]);
  });

  it("a we-call page needs a phone unless one is known", async () => {
    const location = { type: "we_call" as const, description: "Phone call, we'll call you" };
    const out = await runBookingTool(input({ location, modelText: `[[book start="${SLOT_A}" ${WEB_ID}]]` }));
    expect(book).not.toHaveBeenCalled();
    expect(out?.toolResult).toMatch(/you need their phone number/);
    await runBookingTool(input({ location, knownPhone: true, modelText: `[[book start="${SLOT_A}" ${WEB_ID}]]` }));
    expect(book).toHaveBeenCalledTimes(1);
  });

  it("an at-your-address page needs the address", async () => {
    const location = { type: "their_address" as const, description: "At your address" };
    const out = await runBookingTool(input({ location, modelText: `[[book start="${SLOT_A}" ${WEB_ID} address="x"]]` }));
    expect(book).not.toHaveBeenCalled();
    expect(out?.toolResult).toMatch(/full address of the visit/);
  });

  it("the confirmation-email line follows the sub-account's own email setup", async () => {
    // A Resend fallback must not make an unverified SMTP account read as configured.
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", "hi@example.com");
    const smtp = (verifiedAt: string) => ({
      emailProvider: "smtp" as const,
      smtpConfig: {
        host: "smtp.example.com",
        port: 587,
        secure: false,
        username: "u",
        fromEmail: "hi@example.com",
        fromName: "Hi",
        verifiedAt,
      },
    });
    const verified = await runBookingTool(
      input({ emailAccount: smtp("2026-10-01"), modelText: `[[book start="${SLOT_A}" ${WEB_ID}]]` }),
    );
    expect(verified?.toolResult).toMatch(/confirmation email with a calendar invite is on its way to ann@example.com/);
    const unverified = await runBookingTool(
      input({ emailAccount: smtp(""), modelText: `[[book start="${SLOT_A}" ${WEB_ID}]]` }),
    );
    expect(unverified?.toolResult).not.toMatch(/confirmation email/);
  });
});

describe("buildBookingToolsBlock", () => {
  it("phone keeps the copy-the-start-value rules", () => {
    const block = buildBookingToolsBlock(page, "phone");
    expect(block).toContain("COPY the start value character-for-character from the [[slots]] result");
    expect(block).not.toContain("HOST SELECTION");
  });

  it("host selection only on pages that assign one host", () => {
    expect(buildBookingToolsBlock(rrPage, "web-text")).toContain("Our team: Jane Smith, Jake Doe");
    expect(buildBookingToolsBlock(collectivePage, "web-text")).not.toContain("HOST SELECTION");
  });

  it("adds the location, the intake questions and the changeable bookings", () => {
    const block = buildBookingToolsBlock(page, "messaging", {
      location: { type: "in_person", description: "In person at 1 Main Rd" },
      intake: [{ id: "q", label: "Why", type: "text", required: true, options: null }],
      changeable: toChangeTargets(changeable),
    });
    expect(block).toContain("WHERE: In person at 1 Main Rd.");
    expect(block).toContain("- q1: Why (required)");
    expect(block).toContain("- b1: Consult on");
  });

  it("the leftover-marker pattern strips every marker kind", () => {
    const text = 'a [[slots]] b [[book start="x"]] c [[reschedule booking="b1" start="y"]] d [[cancel booking="b1"]] e';
    expect(text.replace(ANY_BOOKING_MARKER_RE, "")).toBe("a  b  c  d  e");
  });
});
