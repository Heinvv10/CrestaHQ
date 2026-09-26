import { vi } from "vitest";
import type { createMemoryFirestore } from "@/test/memory-firestore";

/** Workspace set-up for the PR13 agent tests: social planner, reviews,
 *  broadcasts and outbound voice all switched on and connected. */

type Mem = ReturnType<typeof createMemoryFirestore>;

export const REVIEWS = {
  enabled: true, reviewUrl: "https://g.page/r/fixture/review", channel: "sms",
  messageTemplate: "Hi {{firstName}}, thanks from {{businessName}}! Review us: {{reviewUrl}}",
};
export const TEMPLATE = {
  subAccountId: "sa1", agencyId: "ag1", type: "email", name: "Winter promo", subject: "Winter special",
  body: "Hi {{contact.firstName}}, fibre is half price.\n\nUnsubscribe: {{unsubscribeLink}}", createdByUid: "u1",
};
export const POST = { subAccountId: "sa1", agencyId: "ag1", createdByUid: "u1", caption: "Fast fibre, now in your street.", imageUrl: null, targets: ["facebook"], status: "draft", scheduledAt: null, publishedAt: null, results: [], qstashMessageId: null };
export const VOICE = { outboundEnabled: true, vapiAssistantId: "asst1", vapiPhoneNumberId: "pn1", outboundFirstMessage: "Hi, this is Acme's assistant calling about your install." };

export function seedPr13(mem: Mem) {
  vi.stubEnv("VAPI_API_KEY", "vapi_test");
  vi.stubEnv("VAPI_WEBHOOK_SECRET", "vapi_secret");
  mem.seed("subAccounts/sa1", {
    ...mem.read("subAccounts/sa1"), name: "Acme",
    socialPlannerEnabledByAgency: true, broadcastsEnabledByAgency: true, outboundVoiceEnabledByAgency: true, googleEnabledByAgency: true,
    emailProvider: "smtp", smtpConfig: { verifiedAt: new Date("2026-01-01T00:00:00Z"), host: "smtp.example.com", fromEmail: "hi@acme.example" },
    metaConfig: { connected: true, capabilities: { publish: true }, pageId: "page1", pageName: "Acme Fibre", instagramBusinessAccountId: "ig1" },
    googleReviewConfig: REVIEWS,
  });
  mem.seed("message_templates/tpl_email", TEMPLATE);
  mem.seed("socialPosts/sp1", POST);
  mem.seed("subAccounts/sa1/aiAgent/profile", { timezone: "UTC" });
  mem.seed("subAccounts/sa1/aiAgent/voice", { voice: VOICE });
}
