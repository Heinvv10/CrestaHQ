import { describe, expect, it } from "vitest";
import { isSlackWebhookUrl } from "@/types/slack";
import { buildSlackMessage } from "@/lib/slack/format";
import { WEBHOOK_EVENT_CATEGORIES } from "@/lib/webhooks/event-categories";
import type { EmitWebhookEventInput } from "@/lib/api/webhooks/dispatch";

/**
 * Breaker repros (#449, brk449b): validator bypass attempts, mrkdwn
 * injection through every pickable event type, Slack size limits, and no
 * message or agent text where it must not be.
 */

const GOOD = "https://hooks.slack.com/services/T0001/B0001/aaaaaaaaaaaaaaaaaaaaaaaa";

describe("REPRO 1 validator bypass attempts", () => {
  const bad: [string, string][] = [
    ["trailing dot host", "https://hooks.slack.com./services/T0001/B0001/aaaa"],
    ["uppercase host", "https://HOOKS.SLACK.COM/services/T0001/B0001/aaaa"],
    ["uppercase scheme", "HTTPS://hooks.slack.com/services/T0001/B0001/aaaa"],
    ["trailing newline", `${GOOD}\n`],
    ["trailing space", `${GOOD} `],
    ["leading space", ` ${GOOD}`],
    ["inner tab", "https://hooks.slack.com/services/T0001/B0001/aa\taa"],
    ["backslash", "https://hooks.slack.com\\@evil.test/services/T0001/B0001/aaaa"],
    ["userinfo", "https://hooks.slack.com@evil.test/services/T0001/B0001/aaaa"],
    ["userinfo2", "https://evil.test\\@hooks.slack.com/services/T0001/B0001/aaaa"],
    ["%2e host", "https://hooks%2eslack.com/services/T0001/B0001/aaaa"],
    ["punycode", "https://xn--hooks-slack-9ya.com/services/T0001/B0001/aaaa"],
    ["ipv6", "https://[::1]/services/T0001/B0001/aaaa"],
    ["fragment", `${GOOD}#x`],
    ["trailing slash", `${GOOD}/`],
    ["dotdot", "https://hooks.slack.com/services/../x/B0001/aaaa"],
    ["fullwidth digit", "https://hooks.slack.com/services/T０001/B0001/aaaa"],
    ["default port explicit", "https://hooks.slack.com:443/services/T0001/B0001/aaaa"],
    ["null", null as unknown as string],
    ["object with toString", { toString: () => GOOD } as unknown as string],
  ];
  it.each(bad)("refuses %s", (_l, u) => {
    expect(isSlackWebhookUrl(u)).toBe(false);
  });
  it("accepts GOOD", () => expect(isSlackWebhookUrl(GOOD)).toBe(true));
});

const POISON = "<!channel> <!here> <@U123> <https://evil.test|Click me> &amp; &lt;b&gt; `c` *b* ~s~ _i_ \n> quote\n```code``` :skull: ‮";
const SECRET = "SECRETMESSAGETEXT-8841";

const P = POISON;
const payload = {
  contact: { id: P, name: P, email: P, phone: P, source: P },
  contact_id: P,
  message: { contact_id: P, contact_name: P, channel: P, preview: SECRET },
  booking: { title: P, start_at: "2026-01-01T10:00:00Z", timezone: P },
  call: { from: P, contact_name: P, contact_id: P, transcript: SECRET },
  quote: { id: P, kind: P, number: P, total: 10, currency: P, signature: { signer_name: P }, decline_reason: P },
  deal: { title: P, stage: P, value: 5, currency: P },
  submission: { contact: { id: P, name: P, email: P, phone: P }, values: { msg: SECRET } },
  task: { title: P },
  order: { buyer_name: P, buyer_email: P, currency: P, total_cents: 100, refunded_cents: 1 },
  captured: { name: P, email: P, phone: P },
};

const idsFixed = (o: unknown): unknown => JSON.parse(JSON.stringify(o), (k, v) => (k === "id" || k === "contact_id" ? "abc123" : v));
const cleanPayload = idsFixed(payload) as Record<string, unknown>;
const allTypes = WEBHOOK_EVENT_CATEGORIES.flatMap((c) => c.events);
const mk = (type: string, extra: Partial<EmitWebhookEventInput> = {}): EmitWebhookEventInput => ({
  subAccountId: "sa1", agencyId: "ag1", mode: "live", type: type as never, payload, ...extra,
});

describe("REPRO 2 mrkdwn injection through every event type", () => {
  it.each(allTypes)("%s: no raw control chars in any text", (t) => {
    for (const preview of [false, true]) {
      const msg = buildSlackMessage(mk(t), "https://app.test", { includeMessagePreview: preview });
      const section = (msg.blocks?.[0] as { text: { text: string } }).text.text;
      for (const s of [msg.text, section]) {
        expect(s, `${t} preview=${preview}`).not.toMatch(/[<>]/);
        expect(s).not.toMatch(/&(?!amp;|lt;|gt;)/);
        expect(s).not.toMatch(/[`~]/);
        // bold break-out: more than the two wrapping asterisks
        expect(s.replace(/^\*|\*$/g, "").includes("*") && !s.startsWith("*")).toBe(false);
      }
      const json = JSON.stringify(msg.blocks);
      // button url must be a single well-formed url with no raw angle/space/newline
      const url = ((msg.blocks?.[1] as { elements: { url: string }[] }).elements[0]).url;
      expect(url).toMatch(/^https:\/\/app\.test\/sa\/sa1\/[A-Za-z0-9%._~!*'()\-\/]*$/);
      expect(json.length).toBeLessThan(40_000);
      expect(section.length).toBeLessThan(3000);
    }
  });
  it.each(allTypes)("%s: oversize everything stays under Slack limits", (t) => {
    const big = "&".repeat(5000);
    const bigPayload = JSON.parse(JSON.stringify(cleanPayload).replaceAll(JSON.stringify(P).slice(1, -1), big));
    const msg = buildSlackMessage(mk(t, { payload: bigPayload }), "https://app.test", { includeMessagePreview: true });
    const section = (msg.blocks?.[0] as { text: { text: string } }).text.text;
    expect(section.length).toBeLessThan(3000);
    const url = ((msg.blocks?.[1] as { elements: { url: string }[] }).elements[0]).url;
    expect(url.length, "button url cap 3000").toBeLessThan(3000);
  });
});

describe("REPRO 3 preview off leaks / agent text", () => {
  it.each(allTypes)("%s: preview off never carries message text", (t) => {
    const msg = buildSlackMessage(mk(t), "https://app.test", { includeMessagePreview: false });
    expect(JSON.stringify(msg)).not.toContain(SECRET);
  });
  it.each(allTypes)("%s: apikey actor carries no payload text", (t) => {
    for (const extra of [{ actorUid: "apikey:abc123" }, { byAgent: true }]) {
      const msg = buildSlackMessage(mk(t, { ...extra, payload: cleanPayload }), "https://app.test", { includeMessagePreview: true });
      const s = JSON.stringify(msg);
      expect(s).not.toContain("channel");
      expect(s).not.toContain(SECRET);
      expect(s).not.toContain("evil");
      expect(s).not.toContain("skull");
    }
  });
  it("first name only: a name with no whitespace is posted whole (contact name = message?)", () => {
    const msg = buildSlackMessage(
      mk("message.received", { payload: { message: { contact_id: "c", contact_name: `${SECRET}` , preview: "x" } } }),
      null,
    );
    expect(msg.text).toBe(`New message from ${SECRET}`);
  });
});
