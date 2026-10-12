// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A dialer call's row in the Activity timeline. `meta.recordingUrl` is
 * untrusted (members can write activity rows directly): it becomes a link
 * only when it is exactly a Twilio recording URL, opens in a new tab with
 * rel="noopener noreferrer", and is never embedded or auto-played.
 */

type Row = { id: string; type: string; content: string; createdBy: string; createdAt: Date; meta: unknown };
let rows: Row[];

vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ saPath: (p: string) => `/sa/sa1${p}` }),
}));
vi.mock("@/lib/firestore/contacts", () => ({
  subscribeToNotes: (_id: string, cb: (list: unknown[]) => void) => {
    cb([]);
    return () => {};
  },
}));
vi.mock("@/lib/firestore/activities", () => ({
  subscribeToActivities: (_id: string, cb: (list: Row[]) => void) => {
    cb(rows);
    return () => {};
  },
}));

const { ActivityTimeline } = await import("./activity-timeline");

const SID = `AC${"0a".repeat(16)}`;
const REC = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/RE${"a1".repeat(16)}`;
const call = (meta: unknown, type = "call_placed"): Row => ({
  id: "dialer_CA1",
  type,
  content: "Phone call — 42s",
  createdBy: "dialer",
  createdAt: new Date(),
  meta,
});

let root: Root;
let container: HTMLDivElement;

async function render(list: Row[]) {
  rows = list;
  await act(async () => {
    root.render(createElement(ActivityTimeline, { contactId: "c1" }));
  });
}
const anchors = () => [...container.querySelectorAll("a")];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Activity timeline — a dialer call", () => {
  it("is labelled Phone call, not the fallback Note added", async () => {
    await render([call({ callSid: "CA1", status: "completed", durationSec: 42 })]);
    expect(container.textContent).toContain("Phone call");
    expect(container.textContent).toContain("Phone call — 42s");
    expect(container.textContent).not.toContain("Note added");
    expect(anchors()).toHaveLength(0);
  });

  it.each([REC, `${REC}.mp3`, `${REC}.wav`])("links a valid recording URL: %s", async (url) => {
    await render([call({ callSid: "CA1", recordingUrl: url })]);
    const [link, ...rest] = anchors();
    expect(rest).toHaveLength(0);
    expect(link.getAttribute("href")).toBe(url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toBe("Open recording →");
    expect(link.hasAttribute("download")).toBe(false);
  });

  it("never embeds or plays a recording", async () => {
    await render([call({ recordingUrl: `${REC}.mp3` })]);
    expect(anchors()).toHaveLength(1);
    expect(container.querySelector("audio, video, iframe, embed, object, source, img")).toBeNull();
  });

  it.each([
    ["javascript: scheme", "javascript:alert(document.cookie)"],
    ["javascript: with the URL appended", `javascript:alert(1)//${REC}`],
    ["data: scheme", `data:text/html,<script>alert(1)</script>`],
    ["http, not https", REC.replace("https://", "http://")],
    ["another host", "https://evil.test/2010-04-01/Accounts/x/Recordings/y.mp3"],
    ["a look-alike host suffix", REC.replace("api.twilio.com", "api.twilio.com.evil.test")],
    ["userinfo before the real host", REC.replace("https://api.twilio.com", "https://api.twilio.com@evil.test")],
    ["a regional Twilio host", REC.replace("api.twilio.com", "api.ie1.twilio.com")],
    ["a query string", `${REC}?redirect=https://evil.test`],
    ["a fragment", `${REC}#x`],
    ["a trailing newline", `${REC}\n`],
    ["leading whitespace", ` ${REC}`],
    ["markup after it", `${REC}"><img src=x onerror=alert(1)>`],
    ["another extension", `${REC}.exe`],
    ["a short recording id", `https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/RE1`],
    ["a mis-shaped account", `https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/RE${"a1".repeat(16)}`],
    ["an object", { href: REC }],
    ["an array holding the URL", [REC]],
    ["a number", 42],
    ["null", null],
  ])("renders no link for %s", async (_name, recordingUrl) => {
    await render([call({ callSid: "CA1", recordingUrl })]);
    expect(container.textContent).toContain("Phone call — 42s");
    expect(anchors()).toHaveLength(0);
    expect(container.innerHTML).not.toContain("Open recording");
  });

  it("renders no recording link on a row that is not a dialer call", async () => {
    await render([call({ recordingUrl: REC }, "sms_sent"), { ...call({ recordingUrl: REC }, "note_added"), id: "x2" }]);
    expect(anchors()).toHaveLength(0);
  });

  it("keeps the other deep-links on the row beside the recording", async () => {
    await render([call({ recordingUrl: REC, taskId: "t1" })]);
    expect(anchors().map((a) => a.textContent)).toEqual(["View task →", "Open recording →"]);
  });
});
