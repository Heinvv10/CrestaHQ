import "server-only";

/**
 * VAPID key pair for web push. Generate once per deployment:
 *   npx web-push generate-vapid-keys
 * The public key is NEXT_PUBLIC_* because the browser needs it to
 * subscribe (build-time inlined — redeploy after setting, same caveat as
 * the Pixel/GTM vars). Absent keys = push cleanly disabled: subscribe
 * routes 503, the send helper no-ops, install still works.
 */
export function pushIsConfigured(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY
  );
}

export function getVapidKeys(): { publicKey: string; privateKey: string } {
  return {
    publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "",
    privateKey: process.env.VAPID_PRIVATE_KEY ?? "",
  };
}
