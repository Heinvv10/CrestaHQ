/* LeadStack booking-page embed loader.
 *
 * Snippet:
 *   <div data-leadstack-booking="sa_xxx/consult"></div>
 *   <script src="https://leadstack.dev/booking-embed.js" async></script>
 *
 * What this script does, in order:
 *   1. Read its own src to derive the LeadStack origin (works unmodified
 *      on every deployment, same trick as widget.js).
 *   2. Find every placeholder element carrying `data-leadstack-booking`
 *      (its value is "<subAccountId>/<slug>").
 *   3. Replace each placeholder's content with an <iframe> pointing at
 *      /embed/booking/<subAccountId>/<slug>.
 *   4. Listen for postMessage resize events from the iframe (origin +
 *      message-type checked) and grow/shrink that iframe's height to
 *      match — no inner scrollbar, no guessed fixed height.
 *
 * Vanilla ES2015+. No deps.
 */
(function () {
  "use strict";

  if (window.__leadstackBookingEmbedLoaded) return;
  window.__leadstackBookingEmbedLoaded = true;

  // Duplicated (not imported) from src/components/booking/public-booking-view.tsx's
  // own RESIZE_MESSAGE_SOURCE — this file is a static asset outside that
  // module graph. Keep both in sync by hand if this string ever changes.
  var RESIZE_MESSAGE_SOURCE = "leadstack-booking-embed";
  var PLACEHOLDER_ATTR = "data-leadstack-booking";
  // subAccountId/slug — both plain Firestore-doc-id-shaped segments. Rejects
  // anything with a path separator inside a segment (e.g. "../evil") or a
  // third segment, so the ref can never steer the iframe's src outside
  // /embed/booking/<one>/<other>.
  var REF_RE = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;

  var scriptTag =
    document.currentScript ||
    (function () {
      var all = document.getElementsByTagName("script");
      for (var i = all.length - 1; i >= 0; i--) {
        if ((all[i].src || "").indexOf("/booking-embed.js") !== -1) return all[i];
      }
      return null;
    })();
  if (!scriptTag) return;

  var BASE = (function () {
    try {
      var u = new URL(scriptTag.src);
      return u.protocol + "//" + u.host;
    } catch (_e) {
      return "";
    }
  })();
  if (!BASE) return;

  // iframe.contentWindow -> the container div it belongs to, so a resize
  // message can be matched back to the right iframe even with several
  // widgets on one page.
  var iframesByWindow = [];

  function mount(el) {
    var ref = (el.getAttribute(PLACEHOLDER_ATTR) || "").trim();
    if (!REF_RE.test(ref)) return;

    var iframe = document.createElement("iframe");
    iframe.src = BASE + "/embed/booking/" + ref;
    iframe.title = "Book a meeting";
    iframe.style.cssText =
      "width:100%;border:0;display:block;min-height:480px;";
    iframe.setAttribute("scrolling", "no");
    el.textContent = "";
    el.appendChild(iframe);
    iframesByWindow.push({ window: iframe.contentWindow, iframe: iframe });
  }

  function mountAll() {
    var els = document.querySelectorAll("[" + PLACEHOLDER_ATTR + "]");
    for (var i = 0; i < els.length; i++) mount(els[i]);
  }

  window.addEventListener("message", function (event) {
    if (event.origin !== BASE) return;
    var data = event.data;
    if (!data || data.source !== RESIZE_MESSAGE_SOURCE || data.type !== "resize") return;
    var height = Number(data.height);
    if (!(height > 0)) return;
    for (var i = 0; i < iframesByWindow.length; i++) {
      if (iframesByWindow[i].window === event.source) {
        iframesByWindow[i].iframe.style.height = height + "px";
        return;
      }
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountAll);
  } else {
    mountAll();
  }
})();
