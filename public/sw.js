/**
 * LeadStack service worker — push notifications ONLY.
 *
 * DELIBERATELY NO `fetch` HANDLER. A service worker without one never
 * intercepts network requests, so it cannot cache stale assets, break
 * auth redirects, or interfere with Firestore streams. Offline support
 * is explicitly out of scope — do not add a fetch handler to this file
 * without revisiting that decision (see PWA_V1_PLAN.md).
 *
 * Payload contract (JSON, sent by src/lib/push/send.ts):
 *   { title: string, body: string, url: string, tag?: string }
 */

self.addEventListener("install", () => {
  // Activate updated workers immediately — with no fetch handler there is
  // no cache state to migrate, so skipping the waiting phase is safe.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "New activity", body: event.data.text(), url: "/dashboard" };
  }
  const title = payload.title || "New activity";
  const options = {
    body: payload.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: payload.tag || undefined,
    data: { url: payload.url || "/dashboard" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/dashboard";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        // Focus an existing app window and navigate it; otherwise open new.
        for (const client of windowClients) {
          if ("focus" in client) {
            client.focus();
            if ("navigate" in client) return client.navigate(url);
            return undefined;
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
