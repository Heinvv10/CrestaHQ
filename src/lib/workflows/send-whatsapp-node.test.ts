import { describe, it, expect } from "vitest";
import { defaultConfig, NODE_REQUIREMENT, ADDABLE_TYPES } from "./catalog";
import { resolveWaSendMode } from "@/lib/comms/whatsapp/send-mode";
import { capabilitiesFor } from "@/lib/comms/whatsapp/provider";

/**
 * The `send_whatsapp` node exists to move the free-form-vs-template decision
 * out of the workflow author's hands and into the shared window rule.
 *
 * These tests pin the two properties that motivated it. Both are about cost and
 * reach, and neither is visible from the node's own code — they live in the
 * interaction between the node's config shape and `resolveWaSendMode`.
 */

describe("send_whatsapp node — config shape", () => {
  it("carries a body, unlike whatsapp_template which can only carry a template", () => {
    // The old node's config has no body at all, so it cannot express "send this
    // text" — which is why every send it makes is billed at template rates.
    expect(defaultConfig("whatsapp_template")).not.toHaveProperty("body");
    expect(defaultConfig("send_whatsapp")).toHaveProperty("body");
  });

  it("treats the template as optional", () => {
    // A step that only ever fires inside an open window needs no template, and
    // therefore needs no Meta approval before it can ship.
    const cfg = defaultConfig("send_whatsapp");
    expect(cfg.templateId).toBe("");
  });

  it("is offerable in the builder and declares the whatsapp requirement", () => {
    expect(ADDABLE_TYPES).toContain("send_whatsapp");
    expect(NODE_REQUIREMENT.send_whatsapp).toBe("whatsapp");
  });
});

describe("send_whatsapp node — the send mode it delegates to", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  const justReplied = new Date("2026-09-04T11:59:00Z");
  const lastWeek = new Date("2026-08-28T12:00:00Z");

  it("sends free text when the contact replied a minute ago", () => {
    // The ~$87/mo shape: the review ask fires seconds after a button tap, so
    // the window is open and the message is free. The old node sends a
    // template here regardless.
    expect(
      resolveWaSendMode({
        lastInboundAt: justReplied,
        hasApprovedTemplate: true,
        now,
        capabilities: capabilitiesFor("cloud"),
      }),
    ).toEqual({ mode: "text" });
  });

  it("falls back to the template only once the window has shut", () => {
    expect(
      resolveWaSendMode({
        lastInboundAt: lastWeek,
        hasApprovedTemplate: true,
        now,
        capabilities: capabilitiesFor("cloud"),
      }),
    ).toEqual({ mode: "template" });
  });

  it("refuses rather than sends when the window is shut and no template is set", () => {
    // Skipping is the correct outcome for an optional-template step: an
    // attempted send outside the window is billed AND costs quality rating.
    const r = resolveWaSendMode({
      lastInboundAt: lastWeek,
      hasApprovedTemplate: false,
      now,
      capabilities: capabilitiesFor("cloud"),
    });
    expect(r.mode).toBe("error");
  });

  it("always sends text on the bridge rail, which has no window and no templates", () => {
    // This is what makes the node usable on an unofficial rail: the decision is
    // driven by declared capability, not by a special case.
    for (const lastInboundAt of [null, lastWeek, justReplied]) {
      expect(
        resolveWaSendMode({
          lastInboundAt,
          hasApprovedTemplate: false,
          now,
          capabilities: capabilitiesFor("bridge"),
        }),
      ).toEqual({ mode: "text" });
    }
  });
});
