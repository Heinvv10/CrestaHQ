import { createHash, createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { runId } from "../lib/run-id";

/**
 * The broadcast click redirect and open pixel (W4 PR2) through the real
 * server and middleware, with no session: a signed click token 302s to the
 * destination stored under the broadcast — whatever the query string says —
 * and a forged, bit-flipped or cross-broadcast token 404s; the pixel answers
 * a GIF for any token.
 *
 * The broadcast, its send row and its link doc are this run's own, written
 * directly on the fixture PRIMARY (nothing is emailed). The fixture's
 * tracking switches are left as they are, so this proves the redirect, not
 * the engagement write (unit tests cover that). Tokens are minted here with
 * the same construction as lib/broadcasts/tracking-token.ts, so a format
 * drift goes red. Needs the app's AUTOMATIONS_TOKEN_SECRET, which PR CI sets
 * and the production smoke deliberately lacks: skipped there.
 */

const BASE_PREFIX = "e2e-track-";
const PREFIX = `${BASE_PREFIX}${runId()}-`;
const STALE_MS = 6 * 3600_000;

const env = readEnv();
const sa = env.E2E_SUBACCOUNT_ID;
const secret = process.env.AUTOMATIONS_TOKEN_SECRET;
const stamp = Date.now().toString(36);
const guard = () => assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);

const BROADCAST = `${PREFIX}b-${stamp}`;
const OTHER_BROADCAST = `${PREFIX}b2-${stamp}`;
const CONTACT = `${PREFIX}c-${stamp}`;
const DEST = `https://example.com/e2e-track/${stamp}?a=1&b=2`;
const LINK_KEY = createHash("sha256").update(DEST).digest("hex").slice(0, 32);

const sign = (purpose: string, ids: string[]) =>
  createHmac("sha256", secret ?? "").update(`${purpose}:${ids.join(".")}`).digest("hex");
const clickToken = (b: string, c: string, k: string) =>
  `${b}.${c}.${k}.${sign("broadcast-click", [b, c, k])}`;
const openToken = (b: string, c: string) => `${b}.${c}.${sign("broadcast-open", [b, c])}`;

/** This run's broadcasts, plus any an earlier crashed run left (by age). */
async function purge() {
  const snap = await adminDb().collection("broadcasts").where("subAccountId", "==", sa).get();
  for (const d of snap.docs) {
    if (!d.id.startsWith(BASE_PREFIX)) continue;
    const createdAt = d.data().createdAt;
    const stale = createdAt instanceof Timestamp && Date.now() - createdAt.toMillis() > STALE_MS;
    if (d.id.startsWith(PREFIX) || stale) await deleteScoped(d.ref);
  }
}

async function seedBroadcast(id: string, links: Record<string, string>) {
  const tenancy = { agencyId: env.E2E_AGENCY_ID, subAccountId: sa };
  const ref = adminDb().doc(`broadcasts/${id}`);
  await ref.set({
    ...tenancy,
    channel: "email",
    templateName: `E2E tracking ${stamp}`,
    status: "completed",
    totals: { audienceSize: 1, queued: 0, sent: 1, skipped: 0, failed: 0 },
    createdAt: FieldValue.serverTimestamp(),
  });
  await ref.collection("sends").doc(CONTACT).set({ ...tenancy, contactId: CONTACT, status: "sent" });
  for (const [key, url] of Object.entries(links)) {
    await ref.collection("links").doc(key).set({ ...tenancy, url, createdAt: FieldValue.serverTimestamp() });
  }
}

test.skip(!secret, "AUTOMATIONS_TOKEN_SECRET is not available to this run (production smoke)");

test.beforeAll(async () => {
  await guard();
  await purge();
  await seedBroadcast(BROADCAST, { [LINK_KEY]: DEST });
  await seedBroadcast(OTHER_BROADCAST, { [LINK_KEY]: "https://example.com/e2e-track/other" });
});

test.afterAll(async () => {
  await guard();
  await purge();
});

test("a signed click redirects to the stored destination, never the query string", async ({ request }) => {
  const res = await request.get(
    `/t/c/${clickToken(BROADCAST, CONTACT, LINK_KEY)}?url=https://evil.example/&redirect=https://evil.example/`,
    { maxRedirects: 0 },
  );
  expect(res.status()).toBe(302);
  expect(res.headers()["location"]).toBe(DEST);
});

test("a forged, bit-flipped, cross-broadcast or unknown-link token 404s", async ({ request }) => {
  const good = clickToken(BROADCAST, CONTACT, LINK_KEY);
  const sig = good.split(".")[3]!;
  const flipped = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
  for (const token of [
    "garbage",
    `${BROADCAST}.${CONTACT}.${LINK_KEY}.${"0".repeat(64)}`,
    flipped,
    // The other broadcast HAS a link under this key; the signature is not its own.
    `${OTHER_BROADCAST}.${CONTACT}.${LINK_KEY}.${sig}`,
    clickToken(BROADCAST, CONTACT, "0".repeat(32)),
    openToken(BROADCAST, CONTACT),
  ]) {
    const res = await request.get(`/t/c/${token}`, { maxRedirects: 0 });
    expect(res.status(), token).toBe(404);
    expect(res.headers()["location"], token).toBeUndefined();
  }
});

test("the open pixel is a no-store GIF for any token, without a session", async ({ request }) => {
  for (const token of [openToken(BROADCAST, CONTACT), "garbage"]) {
    const res = await request.get(`/t/o/${token}`, { maxRedirects: 0 });
    expect(res.status(), token).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/gif");
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect((await res.body()).subarray(0, 6).toString("latin1")).toBe("GIF89a");
  }
});
