import { describe, expect, it } from "vitest";
import { isSlackWebhookUrl, SLACK_WEBHOOK_URL_MAX } from "@/types/slack";
import { buildSlackMessage, slackTestMessage } from "@/lib/slack/format";
import type { EmitWebhookEventInput } from "@/lib/api/webhooks/dispatch";

const GOOD = "https://hooks.slack.com/services/T0001/B0001/aaaaaaaaaaaaaaaaaaaaaaaa";

describe("isSlackWebhookUrl", () => {
  it("accepts a Slack Incoming Webhook URL", () => {
    expect(isSlackWebhookUrl(GOOD)).toBe(true);
  });

  it.each([
    ["another host", "https://evil.test/services/T0001/B0001/aaaa"],
    ["a lookalike host", "https://hooks.slack.com.evil.test/services/T0001/B0001/aaaa"],
    ["a subdomain of it", "https://x.hooks.slack.com/services/T0001/B0001/aaaa"],
    ["plain http", "http://hooks.slack.com/services/T0001/B0001/aaaa"],
    ["a port", "https://hooks.slack.com:8443/services/T0001/B0001/aaaa"],
    ["credentials", "https://u:p@hooks.slack.com/services/T0001/B0001/aaaa"],
    ["another path", "https://hooks.slack.com/workflows/T0001/B0001/aaaa"],
    ["a query", `${GOOD}?x=1`],
    ["loopback", "https://127.0.0.1/services/T0001/B0001/aaaa"],
    ["not a string", 42],
  ])("refuses %s", (_label, url) => {
    expect(isSlackWebhookUrl(url)).toBe(false);
  });

  it("refuses an over-long URL that the pattern alone would accept", () => {
    const long = `${GOOD}${"a".repeat(SLACK_WEBHOOK_URL_MAX)}`;
    expect(isSlackWebhookUrl(long)).toBe(false);
  });
});

const ev = (input: Partial<EmitWebhookEventInput>): EmitWebhookEventInput => ({
  subAccountId: "sa1",
  agencyId: "ag1",
  mode: "live",
  type: "contact.created",
  payload: {},
  ...input,
});

function sectionText(msg: { blocks?: unknown[] }): string {
  return (msg.blocks?.[0] as { text: { text: string } }).text.text;
}

describe("buildSlackMessage", () => {
  it("escapes Slack's control characters in tenant text, so it can't link or mention", () => {
    const msg = buildSlackMessage(
      ev({
        payload: {
          contact: { id: "c1", name: "<!channel> <https://evil.test|click> & *Ann*", email: "a<b>@x.test" },
        },
      }),
      "https://app.test",
    );
    for (const out of [msg.text, sectionText(msg)]) {
      expect(out).not.toMatch(/[<>]/);
      expect(out).toContain("&lt;!channel&gt; &lt;https://evil.test|click&gt; &amp; Ann");
      expect(out).toContain("a&lt;b&gt;@x.test");
    }
    expect(sectionText(msg).startsWith("*New lead: ")).toBe(true);
  });

  it("escapes fields outside the per-event copy too (channel, currency)", () => {
    const reply = buildSlackMessage(
      ev({ type: "message.received", payload: { message: { channel: "<!here>", contact_name: "Ann" } } }),
      null,
      { includeMessagePreview: true },
    );
    expect(reply.text).toBe("Ann replied on &lt;!here&gt;");
    const deal = buildSlackMessage(
      ev({ type: "deal.won", payload: { deal: { title: "D", value: 5, currency: "<x>" } } }),
      null,
    );
    expect(deal.text).toBe("Deal won: D — &lt;X&gt; 5");
  });

  it("collapses whitespace and newlines in the headline", () => {
    const msg = buildSlackMessage(ev({ payload: { contact: { name: "Ann\n\n*bold*\t  Lee " } } }), null);
    expect(msg.text).toBe("New lead: Ann bold Lee");
    expect(sectionText(msg)).toBe("*New lead: Ann bold Lee*");
  });

  it("message.received without the preview option: first name only, no context", () => {
    const input = ev({
      type: "message.received",
      payload: { message: { contact_name: "  Ann Lee", preview: "secret", channel: "sms" } },
    });
    const off = buildSlackMessage(input, null);
    expect(off.text).toBe("New message from Ann");
    expect(sectionText(off)).toBe("*New message from Ann*");
    expect(buildSlackMessage(ev({ type: "message.received", payload: { message: {} } }), null).text).toBe("New message");
    expect(buildSlackMessage(input, null, { includeMessagePreview: true }).text).toBe("Ann Lee replied on SMS — “secret”");
  });

  it("an apikey: actor is agent-made even without byAgent", () => {
    const msg = buildSlackMessage(
      ev({ type: "task.created", actorUid: "apikey:lsk_live_x", payload: { task: { title: "Call 0800" } } }),
      null,
    );
    expect(msg.text).toBe("Tasks &amp; Events changed by an API agent");
    const human = buildSlackMessage(ev({ type: "task.created", actorUid: "u1", payload: { task: { title: "Call" } } }), null);
    expect(human.text).toBe("New task: Call");
  });

  it("caps the headline and context", () => {
    const msg = buildSlackMessage(
      ev({ payload: { contact: { name: "&".repeat(5000), email: "e".repeat(5000) } } }),
      null,
    );
    const [headline, context] = sectionText(msg).split("\n");
    expect(headline.length).toBeLessThanOrEqual(150 * 5 + 2);
    expect(context.length).toBeLessThanOrEqual(400);
    expect(sectionText(msg).length).toBeLessThan(3000);
  });

  it("an agent-made write posts fixed copy, never the agent's text", () => {
    const msg = buildSlackMessage(
      ev({ byAgent: true, payload: { contact: { id: "c1", name: "Call 0800 now", email: "x@y.test" } } }),
      "https://app.test",
    );
    expect(msg.text).toBe("New contact added by an API agent");
    expect(JSON.stringify(msg)).not.toContain("0800");
  });

  it("deep-links under the app URL with encoded ids, and omits the button without one", () => {
    const msg = buildSlackMessage(ev({ payload: { contact: { id: "c 1?x" } } }), "https://app.test");
    expect(JSON.stringify(msg.blocks)).toContain('"url":"https://app.test/sa/sa1/contacts/c%201%3Fx"');
    expect(buildSlackMessage(ev({}), null).blocks).toHaveLength(1);
  });

  it("the test message names the brand and links to settings", () => {
    const msg = slackTestMessage("https://app.test", "sa1");
    expect(msg.text).toMatch(/is connected to this channel/);
    expect(msg.text).not.toContain("LeadStack");
    expect(JSON.stringify(msg.blocks)).toContain("https://app.test/sa/sa1/dashboard/settings");
  });
});
