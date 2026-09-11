import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { deleteScoped } from "../lib/guard";

/**
 * Task assignment end to end: create a task assigned to the fixture owner
 * through the dialog, assert `assignedToUid` in Firestore, then prove the
 * assignee filter reads that field — "Me" shows it, "Unassigned" hides it.
 */

test("a task assigned to me shows under Me and not under Unassigned", async ({
  page,
}) => {
  const env = readEnv();
  const stamp = Date.now();
  const title = `E2E Assigned task ${stamp}`;

  const agency = await adminDb().doc(`agencies/${env.E2E_AGENCY_ID}`).get();
  const ownerUid = agency.data()?.ownerUid as string;
  expect(ownerUid).toBeTruthy();
  let taskId: string | null = null;

  try {
    await page.goto(`/sa/${env.E2E_SUBACCOUNT_ID}/tasks`);
    await page.getByRole("button", { name: "New Task" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#task-title").fill(title);
    // The roster loads async; the option appears once it has.
    await expect(dialog.locator("#task-assignee option[value='" + ownerUid + "']")).toHaveCount(1, {
      timeout: 15_000,
    });
    await dialog.locator("#task-assignee").selectOption(ownerUid);
    await dialog.getByRole("button", { name: "Create Task" }).click();

    const findTask = async () => {
      const snap = await adminDb()
        .collection("tasks")
        .where("subAccountId", "==", env.E2E_SUBACCOUNT_ID)
        .where("title", "==", title)
        .limit(1)
        .get();
      return snap.empty ? null : snap.docs[0];
    };
    await expect.poll(async () => (await findTask()) !== null, { timeout: 30_000 }).toBe(true);
    const created = (await findTask())!;
    taskId = created.id;
    expect(created.data().assignedToUid).toBe(ownerUid);

    // A task with no due date lands in "Upcoming"; assert there, per filter.
    const upcoming = page.getByRole("button", { name: /^Upcoming/ });
    const filter = page.getByRole("combobox", { name: "Assignee" });

    await upcoming.click();
    await filter.selectOption("me");
    await expect(page.getByText(title)).toBeVisible({ timeout: 30_000 });

    await filter.selectOption("unassigned");
    await expect(page.getByText(title)).toHaveCount(0);

    await filter.selectOption("anyone");
    await expect(page.getByText(title)).toBeVisible();
  } finally {
    if (taskId) await deleteScoped(adminDb().doc(`tasks/${taskId}`));
  }
});
