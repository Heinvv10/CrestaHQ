import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatWindow } from "@/components/web-chat/chat-window";

const render = (accentColor: string) =>
  renderToStaticMarkup(
    createElement(ChatWindow, { subAccountId: "sa1", welcomeMessage: "hi", accentColor, embedded: true }),
  );

/** The inline style attribute of the element carrying the given aria-label. */
const styleOf = (html: string, label: string) =>
  new RegExp(`<button[^>]*style="([^"]*)"[^>]*aria-label="${label}"|<button[^>]*aria-label="${label}"[^>]*style="([^"]*)"`).exec(html)?.slice(1).find(Boolean) ?? "";

describe("ChatWindow text on accent surfaces", () => {
  it("light accent: header, close button, send button and user bubble use dark text", () => {
    const html = render("#facc15");
    expect(html).toMatch(/background:#facc15;color:#0f172a;padding:14px 16px/);
    expect(styleOf(html, "Close chat")).toContain("color:#0f172a");
    expect(styleOf(html, "Send")).toContain("color:#0f172a");
    expect(html).toMatch(/\.lswc-bubble-user \{\s*background: #facc15;\s*color: #0f172a;/);
    expect(html).toContain("rgba(15,23,42,0.08)");
  });

  it("dark accent: the same surfaces keep white text", () => {
    const html = render("#1e3a8a");
    expect(html).toMatch(/background:#1e3a8a;color:#ffffff;padding:14px 16px/);
    expect(styleOf(html, "Close chat")).toContain("color:#ffffff");
    expect(styleOf(html, "Send")).toContain("color:#ffffff");
    expect(html).toMatch(/\.lswc-bubble-user \{\s*background: #1e3a8a;\s*color: #ffffff;/);
    expect(html).toContain("rgba(255,255,255,0.2)");
  });
});
