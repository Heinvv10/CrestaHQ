import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { expect, test, type Page } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { deleteScoped } from "../lib/guard";

/**
 * SP2 (a) inbox workspace, end to end on the fixture sub-account. Five
 * conversations are seeded with distinct channel / direction / unread /
 * assignee / star values, so every tab, scope and filter has exactly one
 * right answer. Search narrows the list to this run's stamp first, which
 * makes the tab badge and the row lists exact even if the fixture tenant
 * holds other conversations.
 *
 *   row  channel    last dir   unread  assignee   starred  age
 *   A    whatsapp   inbound    2       me         no       1 min
 *   B    email      outbound   0       other      no       2 min
 *   C    sms        inbound    1       none       yes      3 min
 *   D    web-chat   outbound   0       none       no       4 min   (web_ id)
 *   E    messenger  inbound    0       me         no       5 min
 */

type Letter = "A" | "B" | "C" | "D" | "E";

interface SeedRow {
  letter: Letter;
  channel: string;
  direction: "inbound" | "outbound";
  unread: number;
  assignee: "me" | "other" | null;
  starred: boolean;
  ageMin: number;
}

const ROWS: SeedRow[] = [
  {
    letter: "A",
    channel: "whatsapp",
    direction: "inbound",
    unread: 2,
    assignee: "me",
    starred: false,
    ageMin: 1,
  },
  {
    letter: "B",
    channel: "email",
    direction: "outbound",
    unread: 0,
    assignee: "other",
    starred: false,
    ageMin: 2,
  },
  {
    letter: "C",
    channel: "sms",
    direction: "inbound",
    unread: 1,
    assignee: null,
    starred: true,
    ageMin: 3,
  },
  {
    letter: "D",
    channel: "web-chat",
    direction: "outbound",
    unread: 0,
    assignee: null,
    starred: false,
    ageMin: 4,
  },
  {
    letter: "E",
    channel: "messenger",
    direction: "inbound",
    unread: 0,
    assignee: "me",
    starred: false,
    ageMin: 5,
  },
];

test("split-pane inbox: tabs, scope, filters, star, mark unread, sort", async ({
  page,
}) => {
  const env = readEnv();
  const stamp = Date.now();
  const sa = env.E2E_SUBACCOUNT_ID;
  const db = adminDb();
  const ownerUid = (await db.doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()
    ?.ownerUid as string;
  expect(ownerUid, "fixture agency has no ownerUid").toBeTruthy();

  const name = (l: Letter) => `E2E Inbox ${l} ${stamp}`;
  const ids = {} as Record<Letter, string>;
  const contactIds: string[] = [];

  for (const r of ROWS) {
    const tenancy = { agencyId: env.E2E_AGENCY_ID, subAccountId: sa };
    let id: string;
    let contactId: string | null;
    if (r.channel === "web-chat") {
      // Web chat rows are session-keyed with no contact (the anonymous case).
      id = `web_e2e-${stamp}`;
      contactId = null;
    } else {
      const contact = await db.collection("contacts").add({
        name: name(r.letter),
        email: "",
        phone: "",
        company: "",
        address: "",
        source: "e2e-fixture",
        tags: ["e2e-inbox"],
        pipelineStage: null,
        attribution: null,
        ...tenancy,
        createdByUid: ownerUid,
        emailOptedOut: false,
        smsOptedOut: false,
        territoryId: "global",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      id = contact.id;
      contactId = contact.id;
      contactIds.push(contact.id);
    }
    ids[r.letter] = id;
    // Same shape upsertConversationForMessage writes.
    await db.doc(`conversations/${id}`).set({
      ...tenancy,
      territoryId: "global",
      contactId,
      ...(contactId ? {} : { sessionId: `e2e-${stamp}`, visitorLabel: null }),
      contactName: name(r.letter),
      contactPhone: null,
      channelsSeen: [r.channel],
      lastChannel: r.channel,
      lastDirection: r.direction,
      lastMessagePreview: `preview ${r.letter}`,
      lastMessageAt: Timestamp.fromMillis(stamp - r.ageMin * 60_000),
      unreadCount: r.unread,
      status: "open",
      assigneeUid:
        r.assignee === "me"
          ? ownerUid
          : r.assignee === "other"
            ? "e2e-other-uid"
            : null,
      botMode: "off",
      botPausedUntil: null,
      pendingDraft: null,
      ...(r.starred ? { starred: true } : {}),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  const convo = (l: Letter) => db.doc(`conversations/${ids[l]}`);

  const list = page.getByTestId("inbox-list");
  const shown = () => listedLetters(page, stamp);
  const expectRows = (letters: Letter[]) =>
    expect.poll(shown, { timeout: 15_000 }).toEqual(letters);
  const tab = (label: string) =>
    list.getByRole("tab", { name: new RegExp(`^${label}`) });
  const scope = list.getByRole("combobox", { name: "Inbox" });
  const channel = list.getByRole("combobox", { name: "Channel" });
  const direction = list.getByRole("combobox", { name: "Last message" });
  const unreadBadge = list.getByTestId("unread-tab-count");
  const row = (l: Letter) =>
    list.getByTestId("conversation-row").filter({ hasText: name(l) });
  const header = page.getByTestId("thread-header");

  try {
    // --- I1: list route shows the empty right pane beside the list -------
    await page.goto(`/sa/${sa}/conversations`);
    await expect(page.getByText("Select a conversation")).toBeVisible({
      timeout: 30_000,
    });
    await list
      .getByRole("textbox", { name: "Search conversations" })
      .fill(String(stamp));
    await expectRows(["A", "B", "C", "D", "E"]);

    // --- I2: tabs + the Unread badge -------------------------------------
    await expect(unreadBadge).toHaveText("2");
    await tab("Unread").click();
    await expectRows(["A", "C"]);
    await expect(page).toHaveURL(/[?&]tab=unread/);
    await tab("Starred").click();
    await expectRows(["C"]);
    await tab("All").click();
    await expectRows(["A", "B", "C", "D", "E"]);

    // --- I3: inbox scope keyed on assigneeUid ----------------------------
    await scope.selectOption("mine");
    await expectRows(["A", "E"]);
    await scope.selectOption("unassigned");
    await expectRows(["C", "D"]);
    await scope.selectOption("all");

    // --- I4: channel + last direction -------------------------------------
    await channel.selectOption("whatsapp");
    await expectRows(["A"]);
    await channel.selectOption("email");
    await expectRows(["B"]);
    await channel.selectOption("web-chat");
    await expectRows(["D"]);
    await channel.selectOption("");
    await direction.selectOption("inbound");
    await expectRows(["A", "C", "E"]);
    await direction.selectOption("outbound");
    await expectRows(["B", "D"]);
    await scope.selectOption("unassigned");
    await expectRows(["D"]);
    await scope.selectOption("all");
    await direction.selectOption("");

    // --- I8: sort toggle -------------------------------------------------
    await list.getByRole("button", { name: "Sort" }).click();
    await expectRows(["E", "D", "C", "B", "A"]);
    await expect(page).toHaveURL(/[?&]sort=oldest/);
    await list.getByRole("button", { name: "Sort" }).click();
    await expectRows(["A", "B", "C", "D", "E"]);

    // --- I1: open a thread; the list stays beside it, filters survive -----
    await channel.selectOption("email");
    await expectRows(["B"]);
    await row("B").getByRole("link").click();
    await expect(page).toHaveURL(
      new RegExp(`/conversations/${ids.B}\\?channel=email`)
    );
    await expect(header.getByRole("heading", { name: name("B") })).toBeVisible({
      timeout: 30_000,
    });
    await expect(list).toBeVisible();
    await expect(channel).toHaveValue("email");
    await expect(page.getByText("Select a conversation")).toHaveCount(0);
    await channel.selectOption("");
    await expectRows(["A", "B", "C", "D", "E"]);

    // --- I7: mark unread survives staying on the thread -------------------
    await header.getByRole("button", { name: "Mark as unread" }).click();
    await expect
      .poll(async () => (await convo("B").get()).data()?.unreadCount, {
        timeout: 15_000,
      })
      .toBe(1);
    await expect(row("B").getByTestId("row-unread")).toHaveText("1");
    await expect(unreadBadge).toHaveText("3");
    // Opening another thread marks THAT one read and leaves B unread.
    await row("A").getByRole("link").click();
    await expect(header.getByRole("heading", { name: name("A") })).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(async () => (await convo("A").get()).data()?.unreadCount, {
        timeout: 15_000,
      })
      .toBe(0);
    expect((await convo("B").get()).data()?.unreadCount).toBe(1);
    await expect(unreadBadge).toHaveText("2");

    // --- I6: star from the row, unstar from the header, both persist ------
    await row("B").getByRole("button", { name: "Star conversation" }).click();
    await expect
      .poll(async () => (await convo("B").get()).data()?.starred, {
        timeout: 15_000,
      })
      .toBe(true);
    await tab("Starred").click();
    // Reload only once the tab has reached the URL — reloading while
    // router.replace is still in flight reloads the old query.
    await expect(page).toHaveURL(/[?&]tab=starred/);
    await page.reload();
    await expect(tab("Starred")).toHaveAttribute("aria-selected", "true", {
      timeout: 30_000,
    });
    await list
      .getByRole("textbox", { name: "Search conversations" })
      .fill(String(stamp));
    await expectRows(["B", "C"]);
    await row("C").getByRole("link").click();
    await expect(header.getByRole("heading", { name: name("C") })).toBeVisible({
      timeout: 30_000,
    });
    await header.getByRole("button", { name: "Unstar conversation" }).click();
    await expect
      .poll(async () => (await convo("C").get()).data()?.starred, {
        timeout: 15_000,
      })
      .toBe(false);
    await expectRows(["B"]);

    // --- I1: a web_ (session-keyed) thread opens in the split view --------
    await tab("All").click();
    await row("D").getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/conversations/${ids.D}`));
    await expect(header.getByRole("heading", { name: name("D") })).toBeVisible({
      timeout: 30_000,
    });
    await expect(list).toBeVisible();

    // --- I1 mobile: thread alone, Back returns to the list ----------------
    await page.setViewportSize({ width: 400, height: 800 });
    await expect(list).toBeHidden();
    await header.getByRole("button", { name: "Back to conversations" }).click();
    await expect(list).toBeVisible();
    await expect(page.getByText("Select a conversation")).toBeHidden();
  } finally {
    for (const l of Object.keys(ids) as Letter[]) await deleteScoped(convo(l));
    for (const id of contactIds) await deleteScoped(db.doc(`contacts/${id}`));
  }
});

/** Letters of this run's rows, in the order the list renders them. */
async function listedLetters(page: Page, stamp: number): Promise<string[]> {
  const texts = await page
    .getByTestId("inbox-list")
    .getByTestId("conversation-row")
    .allInnerTexts();
  const re = new RegExp(`E2E Inbox ([A-E]) ${stamp}`);
  return texts.flatMap((t) => {
    const m = re.exec(t);
    return m ? [m[1]] : [];
  });
}
