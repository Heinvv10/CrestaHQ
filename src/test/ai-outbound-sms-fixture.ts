import { vi } from "vitest";
import { OPT_OUT_SUFFIX } from "@/lib/comms/ai/outbound-sms-text";

/** A Send AI text step's message, and a line the AI may write in it. */
export const AI_TEMPLATE = "Hi {{firstName}}, it's {{business}}. {{ai}} Shall we send a quote?";
export const AI_LINE = "Fibre has just gone live on your street.";
/** What goes out for the fixture's business ("Velocity Fibre"), with `line`
 *  in the slot or, for null, without it. */
export const aiSmsText = (line: string | null = AI_LINE, name = "Thandi") =>
  `Hi ${name}, it's Velocity Fibre.${line ? ` ${line}` : ""} Shall we send a quote?${OPT_OUT_SUFFIX}`;

/**
 * A sub-account that passes every AI outbound SMS readiness check
 * (lib/comms/ai/outbound-sms.ts) once `OPENROUTER_API_KEY` is set and QStash
 * reads as configured: its own Twilio number with the token in the private
 * secret doc, SMS AI allowed and switched on, and a persona. Seeded through
 * the test's in-memory store; `sub` is merged over the sub-account doc.
 */
export function seedAiSmsReady(
  seed: (path: string, data: Record<string, unknown>) => void,
  subAccountId: string,
  sub: Record<string, unknown> = {},
): void {
  seed(`subAccounts/${subAccountId}`, {
    name: "Velocity",
    agencyId: "ag1",
    aiOutboundSmsEnabledByAgency: true,
    twilioConfig: { enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber: "+27110000000" },
    sendWindow: { startHour: 8, endHour: 20, timezone: "Africa/Johannesburg" },
    ...sub,
  });
  seed(`subAccounts/${subAccountId}/private/twilioCredentials`, { authToken: "tw-token" });
  seed(`subAccounts/${subAccountId}/aiAgent/profile`, {
    systemPrompt: "You are the friendly assistant for Velocity Fibre.",
    businessName: "Velocity Fibre",
    hoursStart: 0,
    hoursEnd: 24,
    timezone: "Africa/Johannesburg",
    escalationKeywords: [],
    escalationNotifyEmail: null,
    websiteUrl: null,
  });
  seed(`subAccounts/${subAccountId}/aiAgent/sms`, {
    enabled: true,
    contextMessageCount: 10,
    modelOverride: null,
    escalationKeywordsOverride: null,
    escalationNotifyEmailOverride: null,
    totalTokensUsed: 0,
    webChat: null,
  });
}

/** An OpenRouter stand-in on global `fetch`: every call answers `reply()`. */
export function stubOpenRouter(reply: () => string, tokens = 120) {
  const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).includes("openrouter.ai")) throw new Error(`unexpected fetch ${url}`);
    calls.push(JSON.parse(String(init?.body)));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "anthropic/claude-haiku-4-5",
        choices: [{ message: { content: reply() } }],
        usage: { prompt_tokens: tokens - 20, completion_tokens: 20, total_tokens: tokens },
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}
