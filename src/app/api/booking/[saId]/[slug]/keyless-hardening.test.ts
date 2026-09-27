import { beforeEach, describe, expect, it, vi } from "vitest";
import { SA, mem, post, resetBookingHarness, seedEvent, seedPage, slot } from "@/test/booking-harness";

/**
 * The public booking routes: a saId / slug that isn't a doc id is the
 * page's own 404 before any read; `excludeEventId` that isn't one is
 * ignored (it can't free a slot); the book body is capped at 64 KB.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/booking/contact-reconcile", async () => (await h()).bookingMocks.reconcile());

const { POST } = await import("./book/route");
const { GET } = await import("./availability/route");

const BAD = ["a/b", "..", "__x__"];
let reads: string[] = [];
const { doc, collection } = mem.db;

beforeEach(() => {
  resetBookingHarness();
  seedPage("p");
  reads = [];
  vi.spyOn(mem.db, "doc").mockImplementation((p: string) => (reads.push(p), doc(p)));
  vi.spyOn(mem.db, "collection").mockImplementation((c: string) => (reads.push(c), collection(c)));
});

const availability = async (saId: string, slug: string, qs = "") => {
  const res = await GET(new Request(`http://x/api?${qs}`), { params: Promise.resolve({ saId, slug }) });
  return { status: res.status, body: await res.json() };
};
const book = (saId: string, slug: string, body: unknown) =>
  POST(post(body), { params: Promise.resolve({ saId, slug }) });
const visitor = { name: "Visitor", email: "v@example.com", phone: "+27600000000", slot: slot("09:00", "09:30") };

describe.each(BAD)("id %j", (bad) => {
  it("availability: a bad saId or slug is a 404 with no read", async () => {
    for (const [saId, slug] of [[bad, "p"], [SA, bad]]) {
      reads = [];
      expect(await availability(saId, slug)).toEqual({ status: 404, body: { error: "Not found" } });
      expect(reads).toEqual([]);
    }
  });

  it("book: a bad saId or slug is a 404 with no read and no event", async () => {
    for (const [saId, slug] of [[bad, "p"], [SA, bad]]) {
      reads = [];
      const res = await book(saId, slug, visitor);
      expect(res.status).toBe(404);
      expect(reads).toEqual([]);
    }
    expect(mem.list("events")).toEqual([]);
  });
});

it("availability: excludeEventId that isn't a doc id can't free its slot", async () => {
  // The same booking stored under a reserved id and under a real one.
  seedEvent("__x__", "09:00", "09:30", { bookingPageSlug: "p" });
  const none = await availability(SA, "p");
  const reserved = await availability(SA, "p", "excludeEventId=__x__");
  expect(reserved).toEqual(none);
  mem.clear();
  resetBookingHarness();
  seedPage("p");
  seedEvent("ev1", "09:00", "09:30", { bookingPageSlug: "p" });
  const busy = await availability(SA, "p");
  const freed = await availability(SA, "p", "excludeEventId=ev1");
  expect(freed).not.toEqual(busy); // a real id still frees its own slot
});

describe("book body cap (64 KB)", () => {
  const padded = (size: number) => {
    const base = JSON.stringify({ ...visitor, extras: { pad: "" } });
    return JSON.stringify({ ...visitor, extras: { pad: "x".repeat(size - base.length) } });
  };
  const chunked = (text: string, headers: Record<string, string> = {}) =>
    new Request("http://x/api", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${Math.random()}`, ...headers },
      body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }),
      duplex: "half",
    } as RequestInit);
  const send = (r: Request) => POST(r, { params: Promise.resolve({ saId: SA, slug: "p" }) });

  it("an at-cap body is read and booked", async () => {
    const body = padded(64 * 1024);
    expect(new TextEncoder().encode(body).length).toBe(64 * 1024);
    expect((await book(SA, "p", JSON.parse(body))).status).toBe(200);
  });

  it.each([
    ["a truthful Content-Length", () => post(JSON.parse(padded(64 * 1024 + 1)))],
    ["no Content-Length (chunked)", () => chunked(padded(64 * 1024 + 1))],
    ["a lying small Content-Length", () => chunked(padded(64 * 1024 + 1), { "content-length": "10" })],
  ])("over the cap with %s is a 413 and books nothing", async (_l, make) => {
    const res = await send(make());
    expect(res.status).toBe(413);
    expect(mem.list("events")).toEqual([]);
  });
});
