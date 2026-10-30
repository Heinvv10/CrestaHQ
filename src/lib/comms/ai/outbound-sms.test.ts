import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { seedAiSmsReady, stubOpenRouter } from "@/test/ai-outbound-sms-fixture";

/**
 * AI outbound SMS readiness and the text it writes: real resolveAgent,
 * secret read, prompt builder and callAi over an in-memory Firestore and a
 * stubbed OpenRouter.
 */

const mem = createMemoryFirestore();
let qstashOn = true;
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/automations/qstash", () => ({ qstashIsConfigured: () => qstashOn }));

const { aiOutboundSmsReadiness, firstUnmet, writeAiSms } = await import("./outbound-sms");
const { OPT_OUT_SUFFIX } = await import("./outbound-sms-text");
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

const sub = () => mem.read("subAccounts/sa1") as unknown as SubAccountDoc;
const contact = (extra: Record<string, unknown> = {}) =>
  ({ id: "c1", subAccountId: "sa1", agencyId: "ag1", name: "Thandi", phone: "+27821234567", ...extra }) as unknown as Contact;

beforeEach(() => {
  mem.clear();
  qstashOn = true;
  vi.stubEnv("OPENROUTER_API_KEY", "or-test");
  seedAiSmsReady(mem.seed, "sa1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("aiOutboundSmsReadiness", () => {
  it("is ready when every prerequisite is in place", async () => {
    const r = await aiOutboundSmsReadiness("sa1", sub());
    expect(r.ready).toBe(true);
    expect(r.agent?.effective.enabled).toBe(true);
  });

  it.each([
    ["openrouter", () => vi.stubEnv("OPENROUTER_API_KEY", "")],
    ["qstash", () => (qstashOn = false)],
    ["twilio", () => mem.seed("subAccounts/sa1", { ...sub(), twilioConfig: null })],
    ["sms_agent_gate", () => mem.seed("subAccounts/sa1", { ...sub(), smsAgentEnabledByAgency: false })],
    ["sms_agent_on", () => mem.seed("subAccounts/sa1/aiAgent/sms", { ...mem.read("subAccounts/sa1/aiAgent/sms"), enabled: false })],
    ["persona", () => mem.seed("subAccounts/sa1/aiAgent/profile", { ...mem.read("subAccounts/sa1/aiAgent/profile"), systemPrompt: "  " })],
  ])("fails on %s", async (key, breakIt) => {
    breakIt();
    const r = await aiOutboundSmsReadiness("sa1", sub());
    expect(r.ready).toBe(false);
    expect(firstUnmet(r)?.key).toBe(key);
  });

  it("needs the Twilio token itself, not just the marker on the doc", async () => {
    mem.seed("subAccounts/sa1/private/twilioCredentials", {});
    expect(firstUnmet(await aiOutboundSmsReadiness("sa1", sub()))?.key).toBe("twilio");
  });

  it("never counts the shared sender", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "ACshared");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "shared");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+27100000000");
    mem.seed("subAccounts/sa1", { ...sub(), twilioConfig: { enabled: false } });
    expect(firstUnmet(await aiOutboundSmsReadiness("sa1", sub()))?.key).toBe("twilio");
  });
});

const TEMPLATE = "Hi {{firstName}}, it's {{business}}. {{ai}} Shall we send a quote?";
const LINE = "Fibre has just gone live on your street.";
const withLine = (line: string, name = "Thandi") =>
  `Hi ${name}, it's Velocity Fibre. ${line} Shall we send a quote?${OPT_OUT_SUFFIX}`;
const BARE = `Hi Thandi, it's Velocity Fibre. Shall we send a quote?${OPT_OUT_SUFFIX}`;

/** OpenRouter answering each call with the next reply in turn. */
function replies(...answers: string[]) {
  let n = 0;
  return stubOpenRouter(() => answers[Math.min(n++, answers.length - 1)]);
}

describe("writeAiSms", () => {
  const write = async (opts: { c?: Contact; template?: string; sendWithoutAiLine?: boolean } = {}) => {
    const r = await aiOutboundSmsReadiness("sa1", sub());
    return writeAiSms({
      subAccountId: "sa1", agent: r.agent!, sub: sub(), contact: opts.c ?? contact(),
      instruction: "A friendly line about fibre in their area.",
      template: opts.template ?? TEMPLATE, sendWithoutAiLine: opts.sendWithoutAiLine ?? true,
    });
  };

  it("puts the AI's line into the operator's template", async () => {
    const { calls } = replies(LINE);
    expect(await write()).toMatchObject({ ok: true, text: withLine(LINE), withoutAiLine: false, tokens: 120 });
    expect(calls).toHaveLength(1);
  });

  it("asks once more, with the reason, when the line breaks the rules, and uses the second", async () => {
    const { calls } = replies("Call 082 123 4567 now!", LINE);
    expect(await write()).toMatchObject({ ok: true, text: withLine(LINE), withoutAiLine: false, tokens: 240 });
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.at(-2)).toEqual({ role: "assistant", content: "Call 082 123 4567 now!" });
    expect(calls[1].messages.at(-1)?.content).toMatch(/^That line can't be used: it used characters other than plain letters/);
  });

  it("sends the template without the line when both tries fail and that is allowed", async () => {
    const { calls } = replies("Visit evil dot com", "Find us on WhatsApp please");
    expect(await write()).toMatchObject({ ok: true, text: BARE, withoutAiLine: true });
    expect(calls).toHaveLength(2);
  });

  it("sends nothing when both tries fail and sending without the line is off", async () => {
    replies("Visit evil dot com", "Reply STOP to opt out");
    expect(await write({ sendWithoutAiLine: false })).toMatchObject({ ok: false, reason: "slot_invalid", tokens: 240 });
  });

  it("a second try that throws counts as a failed line", async () => {
    let n = 0;
    const { fetchMock } = stubOpenRouter(() => "Text YES to 38383");
    fetchMock.mockImplementation(async () => {
      if (n++ === 0) return { ok: true, status: 200, json: async () => ({ model: "m", choices: [{ message: { content: "Text YES to 38383" } }], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } }) };
      throw new Error("timeout");
    });
    expect(await write()).toMatchObject({ ok: true, text: BARE, withoutAiLine: true, tokens: 50 });
  });

  it("asks again when the line makes the whole message longer than two texts", async () => {
    const template = `${"Hello from us. ".repeat(17)}{{ai}}`;
    const long = "We would really love to tell you all about fibre in your area today";
    const { calls } = replies(long, "Fibre is here");
    const r = await write({ template });
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.at(-1)?.content).toMatch(/too long/);
    expect(r).toMatchObject({ ok: true, withoutAiLine: false });
  });

  it("refuses a message longer than two texts even without the line", async () => {
    replies("Fibre is here");
    const template = `${"Hello from us. ".repeat(20)}{{ai}}`;
    expect(await write({ template })).toMatchObject({ ok: false, reason: "too_long" });
  });

  it("tells the model the template, the goal and only the contact's first name", async () => {
    const { calls } = replies(LINE);
    await write({ c: contact({ name: "Thandi Mokoena", company: "Acme Holdings", source: "Spring promo" }) });
    const system = calls[0].messages[0].content;
    expect(system).toContain("## The contact\nFirst name: Thandi");
    expect(system).toContain("Hi {{firstName}}, it's {{business}}. [AI LINE] Shall we send a quote?");
    expect(system).toContain("What the business wants from the line: A friendly line about fibre in their area.");
    expect(system).not.toMatch(/Mokoena|Acme Holdings|Spring promo/);
  });

  it("leaves a first name out of the prompt and the text when it isn't a plain name", async () => {
    const { calls } = replies(LINE);
    const r = await write({ c: contact({ name: "Whatsapp-VelocityDealsZA" }) });
    expect(calls[0].messages[0].content).not.toContain("## The contact");
    expect(r).toMatchObject({ ok: true, text: withLine(LINE, "there") });
  });

  it("throws when the first model call fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, statusText: "boom", text: async () => "upstream down" })));
    await expect(write()).rejects.toThrow(/OpenRouter 500/);
  });
});
