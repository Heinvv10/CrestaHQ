import { describe, expect, it } from "vitest";
import type { ConversationDoc } from "@/types/conversations";
import {
  DEFAULT_INBOX_FILTERS,
  buildInboxView,
  inboxFiltersToQuery,
  parseInboxFilters,
  reconcileUrlQuery,
  sortConversations,
  type InboxFilters,
} from "./inbox-filters";

const ME = "uid-me";

function convo(
  id: string,
  over: Partial<ConversationDoc> & { at: number }
): ConversationDoc {
  const { at, ...rest } = over;
  return {
    id,
    contactId: id,
    subAccountId: "sa",
    agencyId: "ag",
    contactName: `Name ${id}`,
    contactPhone: null,
    channelsSeen: [rest.lastChannel ?? "sms"],
    lastChannel: "sms",
    lastDirection: "inbound",
    lastMessagePreview: "",
    // toDate() accepts a Date; the type only admits Firestore values.
    lastMessageAt: new Date(at) as unknown as ConversationDoc["lastMessageAt"],
    unreadCount: 0,
    status: "open",
    assigneeUid: null,
    botMode: "auto",
    botPausedUntil: null,
    pendingDraft: null,
    createdAt: null,
    updatedAt: null,
    ...rest,
  };
}

// Newest first by `at`: a, b, c, d, e.
const LIST: ConversationDoc[] = [
  convo("c", { at: 300, lastChannel: "sms", unreadCount: 1, starred: true }),
  convo("a", {
    at: 500,
    lastChannel: "whatsapp",
    unreadCount: 2,
    assigneeUid: ME,
    contactPhone: "+27825550101",
  }),
  convo("e", { at: 100, lastChannel: "messenger", assigneeUid: ME }),
  convo("b", {
    at: 400,
    lastChannel: "email",
    lastDirection: "outbound",
    assigneeUid: "uid-other",
  }),
  convo("d", { at: 200, lastChannel: "web-chat", lastDirection: "outbound" }),
];

function view(f: Partial<InboxFilters>, search = "", uid: string | null = ME) {
  return buildInboxView(LIST, { ...DEFAULT_INBOX_FILTERS, ...f }, uid, search);
}
const ids = (rows: ConversationDoc[]) => rows.map((r) => r.id);

describe("buildInboxView", () => {
  it("All tab lists every row newest first", () => {
    expect(ids(view({}).rows)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("Unread and Starred tabs keep only matching rows", () => {
    expect(ids(view({ tab: "unread" }).rows)).toEqual(["a", "c"]);
    expect(ids(view({ tab: "starred" }).rows)).toEqual(["c"]);
  });

  it("counts every tab over the scoped set, whichever tab is active", () => {
    expect(view({ tab: "starred" }).counts).toEqual({
      unread: 2,
      all: 5,
      starred: 1,
    });
    expect(view({ scope: "mine" }).counts).toEqual({
      unread: 1,
      all: 2,
      starred: 0,
    });
  });

  it("scope mine = assigneeUid equals the signed-in uid", () => {
    expect(ids(view({ scope: "mine" }).rows)).toEqual(["a", "e"]);
  });

  it("scope mine shows nothing while the uid is unknown", () => {
    expect(ids(view({ scope: "mine" }, "", null).rows)).toEqual([]);
  });

  it("scope unassigned = no assigneeUid", () => {
    expect(ids(view({ scope: "unassigned" }).rows)).toEqual(["c", "d"]);
  });

  it("channel filter matches lastChannel", () => {
    expect(ids(view({ channel: "whatsapp" }).rows)).toEqual(["a"]);
    expect(ids(view({ channel: "email" }).rows)).toEqual(["b"]);
    expect(ids(view({ channel: "web-chat" }).rows)).toEqual(["d"]);
    expect(ids(view({ channel: "instagram" }).rows)).toEqual([]);
  });

  it("direction filter matches lastDirection", () => {
    expect(ids(view({ direction: "inbound" }).rows)).toEqual(["a", "c", "e"]);
    expect(ids(view({ direction: "outbound" }).rows)).toEqual(["b", "d"]);
  });

  it("combines filters with AND", () => {
    expect(
      ids(view({ tab: "unread", scope: "mine", direction: "inbound" }).rows)
    ).toEqual(["a"]);
  });

  it("search matches name or phone, case-insensitively", () => {
    expect(ids(view({}, "NAME B").rows)).toEqual(["b"]);
    expect(ids(view({}, "5550101").rows)).toEqual(["a"]);
    expect(view({ tab: "unread" }, "name b").counts.unread).toBe(0);
  });

  it("oldest sort reverses the order", () => {
    expect(ids(view({ sort: "oldest" }).rows)).toEqual([
      "e",
      "d",
      "c",
      "b",
      "a",
    ]);
  });
});

describe("sortConversations", () => {
  it("does not mutate its input and puts undated rows last when newest", () => {
    const undated = convo("z", { at: 0, lastMessageAt: null });
    const input = [undated, ...LIST];
    const out = sortConversations(input, "newest");
    expect(out.at(-1)?.id).toBe("z");
    expect(input[0].id).toBe("z");
  });
});

describe("URL round-trip", () => {
  it("defaults serialize to an empty query", () => {
    expect(inboxFiltersToQuery(DEFAULT_INBOX_FILTERS)).toBe("");
  });

  it("parses back what it serialized", () => {
    const f: InboxFilters = {
      tab: "unread",
      scope: "mine",
      channel: "whatsapp",
      direction: "inbound",
      sort: "oldest",
    };
    const qs = inboxFiltersToQuery(f);
    expect(qs).toBe(
      "tab=unread&scope=mine&channel=whatsapp&direction=inbound&sort=oldest"
    );
    expect(parseInboxFilters(new URLSearchParams(qs))).toEqual(f);
  });

  it("falls back to defaults on unknown values", () => {
    expect(
      parseInboxFilters(
        new URLSearchParams("tab=bogus&scope=x&channel=fax&direction=up&sort=z")
      )
    ).toEqual(DEFAULT_INBOX_FILTERS);
  });
});

describe("active conversation exemption", () => {
  const withActive = (f: Partial<InboxFilters>, activeId: string | null) =>
    buildInboxView(LIST, { ...DEFAULT_INBOX_FILTERS, ...f }, ME, "", activeId);

  it("keeps the open conversation on a tab it no longer matches", () => {
    // b is read: without the exemption it would vanish from Unread.
    expect(ids(withActive({ tab: "unread" }, "b").rows)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(ids(withActive({ tab: "unread" }, null).rows)).toEqual(["a", "c"]);
  });

  it("exempts only the tab, not scope / channel / direction", () => {
    expect(ids(withActive({ scope: "mine" }, "b").rows)).toEqual(["a", "e"]);
    expect(ids(withActive({ channel: "sms" }, "b").rows)).toEqual(["c"]);
  });

  it("does not change the tab counts", () => {
    expect(withActive({ tab: "unread" }, "b").counts.unread).toBe(2);
  });
});

describe("reconcileUrlQuery", () => {
  it("adopts a query the pane did not write (external navigation)", () => {
    expect(reconcileUrlQuery("", ["tab=unread"])).toEqual({
      adopt: true,
      pending: [],
    });
    expect(reconcileUrlQuery("tab=starred", [])).toEqual({
      adopt: true,
      pending: [],
    });
  });

  it("ignores the echo of its own write and drops it", () => {
    expect(reconcileUrlQuery("tab=unread", ["tab=unread"])).toEqual({
      adopt: false,
      pending: [],
    });
  });

  it("a late echo of an older write does not revert a newer one", () => {
    // scope=unassigned was written, then scope reset + channel=whatsapp —
    // the first echo must not be adopted over the second write.
    const pending = ["scope=unassigned", "channel=whatsapp"];
    expect(reconcileUrlQuery("scope=unassigned", pending)).toEqual({
      adopt: false,
      pending: ["channel=whatsapp"],
    });
  });

  it("a skipped intermediate echo is dropped with the newer one", () => {
    expect(reconcileUrlQuery("b", ["a", "b"])).toEqual({
      adopt: false,
      pending: [],
    });
  });
});
