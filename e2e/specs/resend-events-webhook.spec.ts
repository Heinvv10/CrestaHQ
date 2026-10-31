import { createHmac, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

/**
 * The Resend events webhook through the real server and middleware, with no
 * session. Middleware redirects a non-public path to /login, so a JSON
 * refusal from the ROUTE proves the exact path is open — and that it fails
 * closed: an unsigned request, one signed with a key this spec just made
 * up, and an oversized body are all refused (503 where the target has no
 * RESEND_WEBHOOK_SECRET, as on CrestaHQ and in PR CI; 401 / 413 where it
 * has one). Nothing this spec sends can verify, so it writes nothing on any
 * target and needs no fixture.
 */

const PATH = "/api/webhooks/resend/events";
const REFUSED: Record<number, string> = {
  503: "Resend webhook is not configured.",
  401: "Invalid signature",
  413: "Request body too large",
};

const body = JSON.stringify({
  type: "email.delivered",
  created_at: new Date().toISOString(),
  data: { email_id: "00000000-0000-4000-8000-000000000000" },
});

function madeUpSignature(raw: string) {
  const id = `msg_e2e${randomBytes(8).toString("hex")}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", randomBytes(32)).update(`${id}.${ts}.${raw}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
}

async function expectRefused(res: { status: () => number; json: () => Promise<unknown> }, allowed: number[]) {
  expect(allowed).toContain(res.status());
  expect(await res.json()).toEqual({ error: REFUSED[res.status()] });
}

test.describe("Resend events webhook — public and fail-closed", () => {
  test("an unsigned event is refused by the route, not redirected", async ({ request }) => {
    const res = await request.post(PATH, {
      data: body,
      headers: { "content-type": "application/json" },
      maxRedirects: 0,
    });
    await expectRefused(res, [503, 401]);
  });

  test("an event signed with an unknown key is refused", async ({ request }) => {
    const res = await request.post(PATH, {
      data: body,
      headers: { "content-type": "application/json", ...madeUpSignature(body) },
      maxRedirects: 0,
    });
    await expectRefused(res, [503, 401]);
  });

  test("an oversized body is refused", async ({ request }) => {
    const big = JSON.stringify({ type: "email.delivered", pad: "x".repeat(70 * 1024) });
    const res = await request.post(PATH, {
      data: big,
      headers: { "content-type": "application/json", ...madeUpSignature(big) },
      maxRedirects: 0,
    });
    await expectRefused(res, [503, 413]);
  });
});
