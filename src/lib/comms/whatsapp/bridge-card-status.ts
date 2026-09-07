/**
 * What the WhatsApp bridge settings card is showing, and when it keeps asking.
 *
 * Both decisions live here rather than inline in the card because both were
 * wrong in ways a rendered component hides: the card polled in exactly the one
 * state its own buttons produce, and it could not distinguish a bridge with no
 * credentials behind it from an ordinary pairing round. Pure functions over
 * the `../whatsapp-bridge/pairing` answer, so the mapping is asserted rather
 * than eyeballed.
 *
 * NOTHING HERE EVER SEES A PAIRING CODE. `../pairing` answers only whether a
 * round is in flight, whether it is connected, when it lapses, and whether the
 * CRM holds credentials. The scannable payload is a PNG from `../qr`.
 */

/** What the manager and the CRM together say about this workspace right now. */
export type BridgeStatus =
  | { kind: "loading" }
  /** No manager on this deployment (a buyer copy, a dev box). Not an outage. */
  | { kind: "unavailable" }
  /** No bridge provisioned for this workspace yet. */
  | { kind: "absent" }
  /**
   * The manager is running a bridge for this workspace and the CRM holds no
   * credentials for it. Pairing a number here links it to a rail that can
   * never send: the token existed once, in the provisioning 201, and there is
   * no route that mints another. Only disconnect-and-reconnect recovers it.
   */
  | { kind: "orphaned" }
  | { kind: "pairing"; expiresAt?: string }
  /** A bridge that is up, unpaired, and not currently offering a code. */
  | { kind: "nocode" }
  | { kind: "connected" }
  | { kind: "error"; message: string };

/** The shape `../pairing` answers with. Every field optional: this is parsed
 *  from a response that may be an error body or nothing at all. */
export interface PairingAnswer {
  pairing?: boolean;
  connected?: boolean;
  credentialsStored?: boolean;
  expiresAt?: string;
  error?: string;
}

/**
 * The card's state from one `../pairing` response.
 *
 * Order matters. `credentialsStored` is checked BEFORE `connected` and before
 * the pairing round: an orphan can report either, and both of those screens
 * invite the admin to use a rail that cannot send.
 *
 * `pairing: false, connected: false` is its own answer, not a fall-through to
 * the QR. The bridge is up and has no code to give — it has issued its handful
 * and stopped, or it has only just started — and rendering the QR panel there
 * draws a broken image with nothing to read.
 */
export function bridgeStatusFrom(
  httpStatus: number,
  data: PairingAnswer,
): BridgeStatus {
  // 503 is "this deployment has no manager" and 404 is "the manager has no
  // tenant for this workspace" — two ordinary answers that must not read as
  // breakage. Everything else genuinely is a fault worth showing.
  if (httpStatus === 503) return { kind: "unavailable" };
  if (httpStatus === 404) return { kind: "absent" };
  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      kind: "error",
      message: data.error ?? "Couldn't read the connection status.",
    };
  }
  if (data.credentialsStored === false) return { kind: "orphaned" };
  if (data.connected) return { kind: "connected" };
  if (data.pairing) return { kind: "pairing", expiresAt: data.expiresAt };
  return { kind: "nocode" };
}

/**
 * Whether this state keeps asking, and whether the asking is capped.
 *
 *   live    — poll for as long as the state lasts.
 *   bounded — poll, but give up after a fixed number of attempts.
 *   none    — a settled answer; sit quiet.
 *
 * `pairing` is live because the scan completes on the customer's phone with
 * nothing to tell this page about it, and the admin is sitting in front of the
 * screen while it happens.
 *
 * `error` and `nocode` poll because they are the NORMAL outcome of the card's
 * own buttons: Connect and "Get a new code" both refresh the moment the
 * manager answers, while the bridge they just started or bounced is not yet
 * listening — so `../pairing` 502s into `error`, or answers a bridge that is
 * up with no code yet. Neither resolves without another read, and without one
 * pressing the primary recovery control simply makes the QR vanish.
 *
 * They are BOUNDED because `error` is also what a genuinely broken deployment
 * answers forever. An unbounded retry there is every open settings tab
 * hammering the manager for as long as the tab is left open, and the "Try
 * again" button already exists for the case where the wait was not enough.
 */
export function bridgePollMode(
  kind: BridgeStatus["kind"],
): "none" | "live" | "bounded" {
  if (kind === "pairing") return "live";
  if (kind === "error" || kind === "nocode") return "bounded";
  return "none";
}
