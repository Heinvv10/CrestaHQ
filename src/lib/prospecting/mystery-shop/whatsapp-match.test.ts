import { describe, expect, it } from "vitest";
import { INSTANT_REPLY_MS, isContentMessage, isWhatsAppAutoReply } from "./whatsapp-match";

const LATER = 5 * 60_000;

describe("isWhatsAppAutoReply — WhatsApp Business away / greeting messages (Meta does not flag them)", () => {
  it.each([
    "Thank you for contacting Acme Plumbing!",
    "Thanks for your message. We will get back to you shortly.",
    "Hi! We'll get back to you as soon as we can.",
    "Hi! We’ll get back to you soon.",
    "Our business hours are Mon–Fri 8:00–17:00.",
    "We are currently unavailable.",
    "We're currently closed.",
    "I'm away from the office.",
    "We are currently away.",
    "Away from the office until Monday.",
    "Outside of our business hours.",
    "Message received outside office hours",
    "Thanks for reaching out!",
    "Thank you for reaching out to Acme.",
    "Thank you for getting in touch!",
    "Thanks for getting in touch.",
    "Welcome to Acme!",
    "Reply 1 for quotes",
    "Thank you for your enquiry.",
    "Thank you for your inquiry.",
    "Thank you for messaging Acme.",
    "We will respond as soon as possible.",
    "Hi, we'll get back to you within the hour",
    "Dankie vir u boodskap!",
    "Dankie vir jou boodskap.",
    "Ons sal so gou moontlik terugkom.",
    "Ons sal jou so gou moontlik antwoord.",
    "Siyabonga ngokusithinta!",
    "Hi! How can we help?",
    "Hello, how can I help you?",
    "THANK YOU FOR\nCONTACTING US",
  ])("automatic (short, the phrase is most of it): %j", (text) => {
    expect(isWhatsAppAutoReply(text, LATER)).toBe(true);
  });

  it.each([
    "Yes we do, when do you need it?",
    "Hi, which area are you in?",
    "",
    "Takeaway menu attached",
    "We're open, come through",
    "Yes! We can send someone right away",
    "We're 10 minutes away from you, can come at 2",
    "Thank you for your message! Yes we do plumbing in Gqeberha, today 2pm?",
    "Thanks! We'll get back to you within the hour about the plumbing job in Gqeberha, what's the address?",
    `Thank you for contacting us. ${"We do geysers, leaks and blocked drains across the metro and can quote today. ".repeat(4)}`,
    "Thank you for contacting us! We'll get back to you. ".repeat(6),
    "2 min away",
  ])("a person (no phrase, or the phrase is not most of a short message): %j", (text) => {
    expect(isWhatsAppAutoReply(text, LATER)).toBe(false);
  });

  it("anything inside the first minute after the send is automatic, whatever it says", () => {
    expect(isWhatsAppAutoReply("Yes we do, when do you need it?", INSTANT_REPLY_MS - 1)).toBe(true);
    expect(isWhatsAppAutoReply("Yes we do, when do you need it?", 0)).toBe(true);
    expect(isWhatsAppAutoReply("Yes we do, when do you need it?", INSTANT_REPLY_MS)).toBe(false);
    expect(isWhatsAppAutoReply("Yes we do, when do you need it?", INSTANT_REPLY_MS + 1_000)).toBe(false);
    expect(isWhatsAppAutoReply("Yes we do, when do you need it?", 90_000)).toBe(false);
  });
});

describe("isContentMessage — only what a person sent counts", () => {
  it.each([
    ["text", "Yes we do"], ["button", "Yes"], ["interactive", "Yes"], ["image", ""], ["video", ""], ["audio", ""],
    ["document", ""], ["sticker", ""], ["location", ""], ["contacts", ""],
  ])("%s is content", (type, text) => {
    expect(isContentMessage(type, text)).toBe(true);
  });

  it.each([
    ["reaction", "👍"], ["system", "changed number"], ["request_welcome", ""], ["unsupported", ""], ["ephemeral", ""],
    ["text", ""], ["text", "   "], ["", "hello"],
  ])("%s %j is not", (type, text) => {
    expect(isContentMessage(type, text)).toBe(false);
  });
});
