import type { Page } from "@playwright/test";

/**
 * Firestore's Listen stream can sit silent for ~30 s after a write, so a UI
 * must show a write from the route's response, not wait for the snapshot.
 * This makes that silence certain: call it once the initial snapshot is in.
 * Holds every NEW Listen request (stall, never abort), then cuts the open
 * stream with a brief offline blip so the SDK has to reconnect into the held
 * requests: nothing more arrives from Firestore. Routing alone is not enough
 * - the open stream is one long response that a route installed afterwards
 * never sees.
 */
export async function stallFirestoreListen(page: Page) {
  await page.route(
    /firestore\.googleapis\.com\/google\.firestore\.v1\.Firestore\/Listen\/channel/,
    () => new Promise(() => {}),
  );
  await page.context().setOffline(true);
  await page.context().setOffline(false);
}
