import { describe, it, expect } from "vitest";
import {
  isWithinServiceWindow,
  resolveWaSendMode,
  WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE,
} from "./send-mode";

const NOW = new Date("2026-09-03T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

describe("isWithinServiceWindow", () => {
  it("is closed when the contact has never messaged in", () => {
    expect(isWithinServiceWindow(null, NOW, 24)).toBe(false);
  });

  it("is open just inside the window", () => {
    expect(isWithinServiceWindow(hoursAgo(23.99), NOW, 24)).toBe(true);
  });

  it("is closed exactly at the boundary", () => {
    // Meta's window is exclusive at 24h. Treating the boundary as open would
    // send a free-form message Meta rejects.
    expect(isWithinServiceWindow(hoursAgo(24), NOW, 24)).toBe(false);
  });

  it("is closed past the window", () => {
    expect(isWithinServiceWindow(hoursAgo(25), NOW, 24)).toBe(false);
  });

  it("honours a shortened window", () => {
    // The channel config allows tightening below 24h. A 4h window must close
    // at 4h even though Meta would still allow the send.
    expect(isWithinServiceWindow(hoursAgo(5), NOW, 4)).toBe(false);
    expect(isWithinServiceWindow(hoursAgo(3), NOW, 4)).toBe(true);
  });

  it("treats a future timestamp as open rather than throwing", () => {
    // Clock skew between the webhook writer and this reader must not crash a
    // send. Erring open here is safe: a just-received inbound is by
    // definition inside the window.
    expect(isWithinServiceWindow(hoursAgo(-1), NOW, 24)).toBe(true);
  });
});

describe("resolveWaSendMode", () => {
  it("sends free-form inside the window even when a template is available", () => {
    // THE MONEY. A marketing template costs ~$0.040; a free-form message
    // inside an open service window costs $0.00. Preferring the template here
    // is what the GHL workflow does today and what this port exists to stop.
    const d = resolveWaSendMode({
      lastInboundAt: hoursAgo(1),
      hasApprovedTemplate: true,
      now: NOW,
      windowHours: 24,
      capabilities: { supportsTemplates: true, enforcesWindow: true, supportsMedia: false, maxMediaBytes: { image: 0, audio: 0, video: 0, document: 0, sticker: 0 }, mediaMimeTypes: [] },
    });
    expect(d.mode).toBe("text");
  });

  it("falls back to a template outside the window", () => {
    const d = resolveWaSendMode({
      lastInboundAt: hoursAgo(30),
      hasApprovedTemplate: true,
      now: NOW,
      windowHours: 24,
      capabilities: { supportsTemplates: true, enforcesWindow: true, supportsMedia: false, maxMediaBytes: { image: 0, audio: 0, video: 0, document: 0, sticker: 0 }, mediaMimeTypes: [] },
    });
    expect(d.mode).toBe("template");
  });

  it("refuses outside the window with no approved template", () => {
    const d = resolveWaSendMode({
      lastInboundAt: hoursAgo(30),
      hasApprovedTemplate: false,
      now: NOW,
      windowHours: 24,
      capabilities: { supportsTemplates: true, enforcesWindow: true, supportsMedia: false, maxMediaBytes: { image: 0, audio: 0, video: 0, document: 0, sticker: 0 }, mediaMimeTypes: [] },
    });
    expect(d).toEqual({
      mode: "error",
      error: WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE,
      providerOutcome: "DEFINITELY_REJECTED",
    });
  });

  it("refuses rather than sending free-form when the provider has no templates but does enforce the window", () => {
    // A provider that is subject to Meta's window but cannot send templates
    // has no legal move outside it. Sending text anyway is the ban risk.
    const d = resolveWaSendMode({
      lastInboundAt: hoursAgo(30),
      hasApprovedTemplate: true,
      now: NOW,
      windowHours: 24,
      capabilities: { supportsTemplates: false, enforcesWindow: true, supportsMedia: false, maxMediaBytes: { image: 0, audio: 0, video: 0, document: 0, sticker: 0 }, mediaMimeTypes: [] },
    });
    expect(d.mode).toBe("error");
  });

  it("sends text outside the window only for a provider not subject to the window", () => {
    // The unofficial bridge is not a Meta rail: there is no service window and
    // no template concept. This branch exists so adding it later is an
    // explicit capability declaration rather than a silently weakened guard.
    const d = resolveWaSendMode({
      lastInboundAt: hoursAgo(300),
      hasApprovedTemplate: false,
      now: NOW,
      windowHours: 24,
      capabilities: { supportsTemplates: false, enforcesWindow: false, supportsMedia: false, maxMediaBytes: { image: 0, audio: 0, video: 0, document: 0, sticker: 0 }, mediaMimeTypes: [] },
    });
    expect(d.mode).toBe("text");
  });

  it("never sends a template through a provider that cannot send one", () => {
    const d = resolveWaSendMode({
      lastInboundAt: null,
      hasApprovedTemplate: true,
      now: NOW,
      windowHours: 24,
      capabilities: { supportsTemplates: false, enforcesWindow: false, supportsMedia: false, maxMediaBytes: { image: 0, audio: 0, video: 0, document: 0, sticker: 0 }, mediaMimeTypes: [] },
    });
    expect(d.mode).toBe("text");
  });
});
