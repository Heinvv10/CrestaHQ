import { describe, expect, it } from "vitest";

import {
  bridgePollMode,
  bridgeStatusFrom,
  type BridgeStatus,
} from "./bridge-card-status";

/**
 * The two decisions the WhatsApp bridge card gets wrong when they are inlined
 * in the component: which state a `/pairing` answer means, and which states
 * keep asking. Both were extracted so they can be asserted here rather than
 * eyeballed in JSX — the card has exactly one call site for each.
 */

describe("bridgeStatusFrom", () => {
  it("reads an orphan — a bridge on the manager with no credentials here — before anything else", async () => {
    // THE case the card could not see. The manager reports an ordinary pairing
    // round, or even a connected one, for a bridge whose token was never
    // saved; both of those screens invite the admin to link a real number to a
    // rail that can never send.
    expect(
      bridgeStatusFrom(200, {
        pairing: true,
        connected: false,
        credentialsStored: false,
        expiresAt: "2026-09-07T10:00:00Z",
      }),
    ).toEqual({ kind: "orphaned" });
    expect(
      bridgeStatusFrom(200, { connected: true, credentialsStored: false }),
    ).toEqual({ kind: "orphaned" });
  });

  it("renders its own state for a bridge that is up with no code on offer", async () => {
    // `pairing: false, connected: false` fell through to the QR panel, which
    // then drew a broken image with no text and no explanation.
    expect(
      bridgeStatusFrom(200, {
        pairing: false,
        connected: false,
        credentialsStored: true,
      }),
    ).toEqual({ kind: "nocode" });
  });

  it("passes a live pairing round through with its expiry", async () => {
    expect(
      bridgeStatusFrom(200, {
        pairing: true,
        connected: false,
        credentialsStored: true,
        expiresAt: "2026-09-07T10:00:00Z",
      }),
    ).toEqual({ kind: "pairing", expiresAt: "2026-09-07T10:00:00Z" });
  });

  it("connects only when the credentials are there", async () => {
    expect(
      bridgeStatusFrom(200, { connected: true, credentialsStored: true }),
    ).toEqual({ kind: "connected" });
  });

  it("treats 503 and 404 as ordinary answers, not breakage", async () => {
    // 503 is "no manager on this deployment" — a buyer copy, a dev box — and
    // 404 is "the manager has no tenant for this workspace", which is what
    // every workspace looks like before it connects one.
    expect(bridgeStatusFrom(503, {})).toEqual({ kind: "unavailable" });
    expect(bridgeStatusFrom(404, {})).toEqual({ kind: "absent" });
  });

  it("shows the server's sentence on a real fault, and its own when there is none", async () => {
    expect(bridgeStatusFrom(502, { error: "the bridge is unreachable" })).toEqual(
      { kind: "error", message: "the bridge is unreachable" },
    );
    expect(bridgeStatusFrom(500, {})).toEqual({
      kind: "error",
      message: "Couldn't read the connection status.",
    });
  });

  it("does not read a missing credentialsStored as an orphan", async () => {
    // An older deployment, or a response that lost the field, must not
    // strand every workspace on the orphan screen. Only an explicit false
    // means orphaned.
    expect(bridgeStatusFrom(200, { pairing: true })).toEqual({
      kind: "pairing",
      expiresAt: undefined,
    });
  });
});

describe("bridgePollMode", () => {
  it("keeps asking in the two states the card's own buttons produce", async () => {
    // Both Connect and "Get a new code" refresh the moment the manager
    // answers, while the bridge they just started or bounced is not yet
    // listening — so `/pairing` 502s into `error`, or answers a bridge that is
    // up with no code yet. Polling only in `pairing` meant the normal outcome
    // of pressing the primary recovery control was the QR vanishing for good.
    //
    // BOUNDED rather than live: `error` is also what a genuinely broken
    // deployment answers forever, and an unbounded retry there is every open
    // settings tab hammering the manager for as long as the tab lives. That is
    // what these two assertions pin — a `.not.toBe("live")` alongside them
    // would add nothing, since it passes for "none" too.
    expect(bridgePollMode("error")).toBe("bounded");
    expect(bridgePollMode("nocode")).toBe("bounded");
  });

  it("polls a live pairing round without a cap", async () => {
    // The scan completes on the customer's phone with nothing to tell this
    // page about it, and the admin is watching the screen while it happens.
    expect(bridgePollMode("pairing")).toBe("live");
  });

  it("sits quiet on every settled answer", async () => {
    const settled: BridgeStatus["kind"][] = [
      "loading",
      "unavailable",
      "absent",
      "orphaned",
      "connected",
    ];
    for (const kind of settled) {
      expect(bridgePollMode(kind)).toBe("none");
    }
  });
});
