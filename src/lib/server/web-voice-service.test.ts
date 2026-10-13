import { describe, expect, it, vi } from "vitest";

/**
 * `webVoiceAvailable` — whether visitors may see the mic. The call path
 * (WV-2) answers `voiceEnabled:false` on its say-so, so every condition is
 * pinned on its own: both agency gates, a provisioned agent, the operator
 * switch.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { webVoiceAvailable } = await import("./web-voice-service");
import type { SubAccountDoc } from "@/types";
import type { WebVoiceMeta } from "@/types/web-voice";

const META = { ready: true, enabled: true } as WebVoiceMeta;
const sub = (over: Partial<SubAccountDoc> = {}) =>
  ({ webVoiceEnabledByAgency: true, webVoiceMeta: META, ...over }) as SubAccountDoc;

describe("webVoiceAvailable", () => {
  it("is true with both gates on (web chat by default), a ready agent and the switch on", () => {
    expect(webVoiceAvailable(sub())).toBe(true);
  });

  it.each<[string, SubAccountDoc | null]>([
    ["no sub-account", null],
    ["Web Voice gate absent (opt-in)", sub({ webVoiceEnabledByAgency: undefined })],
    ["Web Voice gate off", sub({ webVoiceEnabledByAgency: false })],
    ["Web Chat gate off", sub({ webChatEnabledByAgency: false })],
    ["not connected", sub({ webVoiceMeta: null })],
    ["agent not provisioned", sub({ webVoiceMeta: { ...META, ready: false } })],
    ["operator switch off", sub({ webVoiceMeta: { ...META, enabled: false } })],
  ])("is false when %s", (_n, s) => {
    expect(webVoiceAvailable(s)).toBe(false);
  });
});
