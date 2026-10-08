import { describe, expect, it } from "vitest";
import { isWhatsAppAutoReply } from "./whatsapp-match";

describe("isWhatsAppAutoReply — WhatsApp Business away / greeting messages (Meta does not flag them)", () => {
  it.each([
    "Thank you for contacting Acme Plumbing! How can we help?",
    "Thanks for your message. We will get back to you shortly.",
    "Hi! We'll get back to you as soon as we can.",
    "Hi! We’ll get back to you soon.",
    "Our business hours are Mon–Fri 8:00–17:00.",
    "We are currently unavailable.",
    "We're currently closed.",
    "I'm away from the office.",
    "You have reached us outside of our business hours.",
    "Message received outside office hours",
    "We are outside our working hours right now",
    "Dankie vir u boodskap!",
    "Ons sal so gou moontlik terugkom na u.",
    "THANK YOU FOR\nCONTACTING US",
  ])("automatic: %j", (text) => {
    expect(isWhatsAppAutoReply(text)).toBe(true);
  });

  it.each([
    "Yes we do, when do you need it?",
    "Hi, which area are you in?",
    "Sure — tomorrow at 9?",
    "",
    "Takeaway menu attached",
    "We're open, come through",
  ])("a person: %j", (text) => {
    expect(isWhatsAppAutoReply(text)).toBe(false);
  });
});
