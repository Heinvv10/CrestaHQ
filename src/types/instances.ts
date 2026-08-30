/**
 * A deployed LeadStack instance that has phoned home to this mothership.
 *
 * One row per unique `instanceId` (a stable UUID each deployment persists at
 * `system/heartbeat`). Written server-side only by the heartbeat receiver
 * (`/api/v1/leadstack/heartbeat`) via the Admin SDK; read server-side by the
 * agency-owner "Instances" fleet view. Never touched by any client.
 *
 * Buyer deployments report by default (the mothership URL is baked into the
 * template); a buyer can opt out with `GITPAGE_TELEMETRY=off`, so the fleet
 * view is a best-effort signal — "instances we can see," not a licence check.
 */
export interface InstanceRecord {
  /** Stable per-deployment UUID (doc id). */
  instanceId: string;
  /** Bootstrap / agency-owner email the deployment attributes itself to. */
  ownerEmail: string;
  /** App version string the deployment reports (e.g. "0.1.0"). */
  version: string | null;
  /** Host platform: vercel | render | railway | fly | self-hosted. */
  platform: string | null;
  /** Sub-account count (only sent by the daily cron ping; null on boot pings). */
  subAccountCount: number | null;
  /** Whether the deployment has a gitpage API key configured. */
  hasGitpageKey: boolean;
  /** First time this instance was ever seen (epoch ms). */
  firstSeenAtMs: number | null;
  /** Most recent heartbeat (epoch ms) — drives active/idle status. */
  lastSeenAtMs: number | null;
  /** Total heartbeats received from this instance. */
  heartbeatCount: number;
  /**
   * Set true when a chargeback dispute was raised on the purchase whose email
   * matches this instance's ownerEmail — surfaces a "still running after
   * dispute" flag in the fleet view. Set by the Stripe dispute handler.
   */
  disputed?: boolean;
}
