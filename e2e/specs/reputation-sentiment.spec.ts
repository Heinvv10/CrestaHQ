import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { FIXTURE_PRIMARY_NAME } from "../lib/env";
import {
  LOC_A,
  defaultScenario,
  feedPath,
  gbpLifecycle,
  patchScenario,
  primaryId,
  primaryRef,
  putWidget,
  reviewDocs,
  runCron,
  setScenario,
  type Scenario,
} from "../lib/gbp";
import { assertFixtureSubAccount } from "../lib/guard";

/**
 * SP5 (b) — review sentiment (ledger R4, V7). On the fixture PRIMARY with
 * the fenced Reviews AI fake (REVIEWS_AI_PROVIDER=fake; every call logged as
 * ids + count at private/reviewsAiFakeLog — what would have been billed):
 * the signed cron syncs the fake's seven reviews (re-dated into the default
 * range) and labels them — star-only from the stars, text by the "AI", one
 * item per text review; a second sync bills nothing; editing one review
 * bills exactly one more; the badges, the Overview donut, and a public feed
 * that carries no sentiment.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake and REVIEWS_AI_PROVIDER=fake, which a deployed target refuses by design");

gbpLifecycle(test);

const DAY = 24 * 3600_000;
const VELO = "https://www.velocityfibre.co.za";
const guard = () => assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
const privateDoc = (id: string) => primaryRef().collection("private").doc(id);

/** The default scenario, each review (i*3 + 1) days ago, so the Overview's 90-day default holds them. */
function recentScenario(now: number): Scenario {
  const s = defaultScenario();
  s.reviews[LOC_A].reviews.forEach((r, i) => {
    const created = new Date(now - (i * 3 + 1) * DAY).toISOString();
    Object.assign(r, { createTime: created, updateTime: created });
    const reply = r.reply as { updateTime: string } | null;
    if (reply) reply.updateTime = new Date(Date.parse(created) + 3 * 3600_000).toISOString();
  });
  return s;
}

/** Items the fake AI was asked to classify, across every call. */
async function billed(): Promise<number> {
  const calls = ((await privateDoc("reviewsAiFakeLog").get()).data()?.calls ?? []) as Array<{ count: number }>;
  return calls.reduce((n, c) => n + c.count, 0);
}

/** Set once setup has read the gate and before it writes it (teardown runs even if setup throws). */
let priorGate: { value: unknown } | null = null;
const now = Date.now();

test.beforeAll(async () => {
  await guard();
  const value = (await primaryRef().get()).data()?.reviewsAiEnabledByAgency;
  await privateDoc("reviewsAiFakeLog").delete();
  await privateDoc("sentimentLease").delete();
  await setScenario(recentScenario(now));
  priorGate = { value };
  await primaryRef().update({ reviewsAiEnabledByAgency: true });
});

test.afterAll(async () => {
  const errors: unknown[] = [];
  const step = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      errors.push(err);
    }
  };
  await step(guard);
  if (errors.length) throw errors[0]; // never touch a doc the guard did not clear
  // The private docs carry no tenant fields; their parent was asserted above.
  await step(() => privateDoc("reviewsAiFakeLog").delete());
  await step(() => privateDoc("sentimentLease").delete());
  const prior = priorGate;
  if (prior) {
    await step(() => primaryRef().update({ reviewsAiEnabledByAgency: prior.value === undefined ? FieldValue.delete() : prior.value }));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "reputation-sentiment teardown: several steps failed");
});

test("sync labels each review once; edits re-bill exactly one; badges, donut, and a feed without sentiment", async ({ page, request }) => {
  const scenario = recentScenario(now).reviews[LOC_A].reviews as Array<{ reviewId: string; comment: string | null }>;
  const withText = scenario.filter((r) => r.comment !== null && r.comment.trim() !== "").length;
  expect(withText).toBe(6);

  // --- First sync: every review labelled; the AI was asked once per text review.
  await runCron(request);
  await expect.poll(async () => (await reviewDocs()).filter((d) => d.sentiment).length, { timeout: 30_000 }).toBe(7);
  expect(await billed()).toBe(withText);

  // --- Badges in the reviews list.
  await page.goto(`/sa/${primaryId()}/reputation/reviews`);
  const expected: Array<[string, string, string]> = [
    ["fake-r7", "positive", "ai"], ["fake-r6", "negative", "ai"], ["fake-r5", "neutral", "ai"], ["fake-r4", "positive", "ai"],
    ["fake-r3", "positive", "rating"], ["fake-r2", "negative", "ai"], ["fake-r1", "neutral", "ai"],
  ];
  for (const [id, label, method] of expected) {
    const badge = page.getByTestId(`gbp-review-sentiment-${id}`);
    await expect(badge).toHaveAttribute("data-label", label, { timeout: 30_000 });
    await expect(badge).toHaveAttribute("data-method", method);
  }
  await expect(page.getByTestId("gbp-review-sentiment-fake-r3")).toHaveAttribute("title", "From the star rating");

  // --- Second sync of unchanged reviews: nothing re-billed.
  await runCron(request);
  expect(await billed()).toBe(withText);

  // --- Edit one review at "Google": exactly one more AI item, and its label follows the new text.
  const edited = recentScenario(now);
  const r1 = edited.reviews[LOC_A].reviews.find((r) => r.reviewId === "fake-r1")!;
  Object.assign(r1, { comment: "Fixture review: edited — terrible after the upgrade.", updateTime: new Date(now).toISOString() });
  await patchScenario({ reviews: edited.reviews });
  await runCron(request);
  await expect.poll(billed, { timeout: 30_000 }).toBe(withText + 1);
  await page.reload();
  await expect(page.getByTestId("gbp-review-sentiment-fake-r1")).toHaveAttribute("data-label", "negative", { timeout: 30_000 });

  // --- The Overview donut: counted from the labels now stored.
  const docs = (await reviewDocs()).filter((d) => d.state === "active");
  const count = (label: string) => String(docs.filter((d) => (d.sentiment as { label?: string } | null)?.label === label).length);
  expect([count("positive"), count("neutral"), count("negative")]).toEqual(["3", "1", "3"]);
  await page.goto(`/sa/${primaryId()}/reputation`);
  for (const label of ["positive", "neutral", "negative"]) {
    await expect(page.getByTestId(`rep-sentiment-${label}`)).toHaveAttribute("data-count", count(label), { timeout: 30_000 });
  }
  await expect(page.getByTestId("rep-sentiment-not-analysed")).toHaveCount(0);

  // --- The public feed carries no sentiment.
  const publicId = await putWidget(page, { enabled: true, allowedOrigins: [VELO], maxReviews: 12 });
  const res = await request.get(feedPath(publicId), { headers: { Origin: VELO } });
  expect(res.status()).toBe(200);
  const text = await res.text();
  expect((JSON.parse(text) as { reviews: unknown[] }).reviews).toHaveLength(7);
  expect(text).not.toMatch(/sentiment|basisHash|"(positive|neutral|negative)"/);
});

test("with the Reviews AI gate off the Overview says so and nothing is sent to the AI", async ({ page, request }) => {
  await guard();
  await primaryRef().update({ reviewsAiEnabledByAgency: false });
  const before = await billed();
  await runCron(request);
  expect(await billed()).toBe(before);
  await page.goto(`/sa/${primaryId()}/reputation`);
  await expect(page.getByTestId("rep-sentiment-gate-off")).toHaveText(
    "Reviews AI is off for this sub-account — your agency can switch it on.",
    { timeout: 30_000 },
  );
});
