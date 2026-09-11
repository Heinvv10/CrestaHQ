/* CrestaHQ Google reviews embed — contract: docs/features/gbp-reviews.md › Embed contract
 *
 *   <div data-crestahq-reviews="PUBLIC_ID" data-api="https://crm.crestahq.com">
 *     <!-- static fallback: shown as-is with JS off or when the feed fails -->
 *     <p><a href="https://…">Read our reviews on Google</a></p>
 *   </div>
 *   <script src="https://crm.crestahq.com/embed/gbp-reviews.js" defer></script>
 *
 * Per container: data-state="loading" (fallback visible) → GET
 * {data-api}/api/public/gbp/feed/{id} with no cookies (the page's origin must
 * be on the widget's allow-list) → status ok / stale replaces the fallback
 * with the carousel ("Last updated <date>" when stale); anything else leaves
 * the fallback untouched, data-state="fallback".
 *
 * Feed data reaches the page through textContent only; only http(s) links from
 * the feed are clickable. Rotation rules: see rotation() below. Containers are
 * found once, when the script runs — one added later keeps its fallback.
 * Vanilla ES2017, no dependencies, safe to include more than once.
 */
(function () {
  "use strict";

  var FEED_PATH = "/api/public/gbp/feed/";
  var AUTO_ADVANCE_MS = 8000;
  var CSS_ID = "chq-reviews-css";
  var CSS = [
    ".chq-reviews{font:inherit;color:inherit;max-width:40rem}",
    ".chq-reviews__head{margin-bottom:.75rem}",
    ".chq-reviews__title{font-weight:600;margin:0}",
    ".chq-reviews__rating,.chq-reviews__source,.chq-reviews__stale{margin:.25rem 0 0;font-size:.875em}",
    ".chq-reviews__stale{opacity:.75;font-style:italic}",
    ".chq-reviews__carousel{border:1px solid rgba(0,0,0,.15);border-radius:.5rem;padding:1rem}",
    ".chq-reviews__carousel:focus-visible{outline:2px solid currentColor;outline-offset:2px}",
    ".chq-reviews__slide{margin:0}",
    ".chq-reviews__stars{margin:0;letter-spacing:.1em}",
    ".chq-reviews__text{margin:.5rem 0;white-space:pre-wrap}",
    ".chq-reviews__author{font-size:.875em;opacity:.8}",
    ".chq-reviews__reply{margin:.5rem 0 0;padding-left:.75rem;border-left:2px solid rgba(0,0,0,.2);font-size:.875em;white-space:pre-wrap}",
    ".chq-reviews__controls{display:flex;align-items:center;gap:.75rem;margin-top:.75rem}",
    ".chq-reviews__controls button{font:inherit;cursor:pointer;min-width:2.25rem;min-height:2.25rem}",
  ].join("\n");

  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    var style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  /** Every piece of feed data goes through here: text, never markup. */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function httpUrl(value) {
    try {
      var url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch (_err) {
      return null;
    }
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function stars(n) {
    var r = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    return "★★★★★".slice(0, r) + "☆☆☆☆☆".slice(0, 5 - r);
  }

  function header(feed) {
    var head = el("div", "chq-reviews__head");
    var listing = feed.listing || {};
    head.appendChild(el("p", "chq-reviews__title", listing.title || ""));
    if (feed.rating) {
      var count = feed.rating.count;
      var average = (Math.round(Number(feed.rating.average) * 10) / 10).toFixed(1);
      head.appendChild(el("p", "chq-reviews__rating",
        average + " ★ · " + count + (count === 1 ? " review" : " reviews")));
    }
    var source = el("p", "chq-reviews__source");
    var attribution = (feed.source && feed.source.attribution) || "Reviews from Google";
    var maps = httpUrl(listing.mapsUri);
    if (maps) {
      var link = el("a", null, attribution);
      link.href = maps;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      source.appendChild(link);
    } else {
      source.textContent = attribution;
    }
    head.appendChild(source);
    if (feed.status === "stale") {
      var when = formatDate(feed.freshness && feed.freshness.lastSuccessfulSyncAt);
      head.appendChild(el("p", "chq-reviews__stale", "Last updated " + (when || "a while ago")));
    }
    return head;
  }

  function slide(review, index, total) {
    var fig = el("figure", "chq-reviews__slide");
    fig.setAttribute("role", "group");
    fig.setAttribute("aria-roledescription", "slide");
    fig.setAttribute("aria-label", index + 1 + " of " + total);
    var starsNode = el("p", "chq-reviews__stars", stars(review.rating));
    starsNode.setAttribute("aria-label", review.rating + " out of 5 stars");
    fig.appendChild(starsNode);
    if (review.text !== null && review.text !== undefined) {
      fig.appendChild(el("blockquote", "chq-reviews__text", review.text));
    }
    var author = review.author || {};
    var name = author.anonymous || !author.name ? "A Google user" : author.name;
    fig.appendChild(el("figcaption", "chq-reviews__author", name + " · " + formatDate(review.createdAt)));
    if (review.reply && review.reply.text) {
      fig.appendChild(el("p", "chq-reviews__reply", "Response from the owner: " + review.reply.text));
    }
    return fig;
  }

  function carousel(reviews) {
    var region = el("div", "chq-reviews__carousel");
    region.setAttribute("role", "region");
    region.setAttribute("aria-roledescription", "carousel");
    region.setAttribute("aria-label", "Google reviews");
    region.tabIndex = 0;
    var track = el("div", "chq-reviews__slides");
    track.setAttribute("aria-live", "polite");
    var slides = reviews.map(function (r, i) {
      var s = slide(r, i, reviews.length);
      track.appendChild(s);
      return s;
    });
    region.appendChild(track);

    var current = 0;
    var counter = el("span", "chq-reviews__count");
    function show(i) {
      current = (i + slides.length) % slides.length;
      slides.forEach(function (s, n) {
        s.hidden = n !== current;
      });
      counter.textContent = current + 1 + " / " + slides.length;
    }
    var motion = rotation(region, track, function () {
      show(current + 1);
    }, slides.length);
    // Any manual step stops automatic rotation for good.
    function step(n) {
      motion.interacted();
      show(current + n);
    }
    function button(label, symbol, n) {
      var b = el("button", null, symbol);
      b.type = "button";
      b.setAttribute("aria-label", label);
      b.addEventListener("click", function () {
        step(n);
      });
      return b;
    }
    var controls = el("div", "chq-reviews__controls");
    controls.appendChild(button("Previous review", "‹", -1));
    controls.appendChild(counter);
    controls.appendChild(button("Next review", "›", 1));
    controls.appendChild(motion.toggle);
    region.appendChild(controls);
    region.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    });
    show(0);
    motion.init();
    return region;
  }

  /**
   * Automatic rotation with the visitor in control (WCAG 2.2.2): never while
   * prefers-reduced-motion is on (watched live), never faster than every 8s,
   * paused while hovered or focused, a labelled pause/play button, and any
   * use of prev/next or the arrow keys stops it for good. Turning reduced
   * motion off restarts it only if the visitor never interacted. The timer
   * clears itself once the widget has left the page.
   */
  function rotation(region, track, advance, count) {
    var query = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    var timer = null, hovered = false, focused = false, interacted = false;
    var toggle = el("button", "chq-reviews__toggle");
    toggle.type = "button";
    function reduced() {
      return !query || query.matches;
    }
    function sync() {
      toggle.setAttribute("aria-label", timer ? "Pause automatic rotation" : "Start automatic rotation");
      toggle.textContent = timer ? "❚❚" : "▶";
      // WAI carousel pattern: no announcements while it rotates on its own.
      track.setAttribute("aria-live", timer && !hovered && !focused ? "off" : "polite");
    }
    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
      sync();
    }
    function start() {
      if (timer || reduced() || count < 2) return;
      timer = setInterval(function () {
        if (!region.isConnected) return stop();
        if (!hovered && !focused) advance();
      }, AUTO_ADVANCE_MS);
      sync();
    }
    function onMotion() {
      toggle.hidden = reduced() || count < 2;
      if (reduced()) stop();
      else if (!interacted) start();
    }
    toggle.addEventListener("click", function () {
      interacted = true;
      if (timer) stop();
      else start();
    });
    region.addEventListener("mouseenter", function () { hovered = true; sync(); });
    region.addEventListener("mouseleave", function () { hovered = false; sync(); });
    // Focus on the pause/play button itself does not pause: pressing Play must play.
    region.addEventListener("focusin", function (e) { focused = e.target !== toggle; sync(); });
    region.addEventListener("focusout", function () { focused = false; sync(); });
    if (query && query.addEventListener) query.addEventListener("change", onMotion);
    else if (query && query.addListener) query.addListener(onMotion);
    return {
      toggle: toggle,
      init: function () {
        onMotion();
        sync();
      },
      interacted: function () {
        interacted = true;
        stop();
      },
    };
  }

  function render(container, feed) {
    var root = el("div", "chq-reviews");
    root.appendChild(header(feed));
    var reviews = Array.isArray(feed.reviews) ? feed.reviews : [];
    // Reviews exist at Google but none are in the served window: the header
    // alone, rather than "no reviews" under a count that says otherwise.
    var counted = feed.rating && feed.rating.count > 0;
    if (reviews.length > 0) root.appendChild(carousel(reviews));
    else if (!counted) root.appendChild(el("p", "chq-reviews__empty", "No Google reviews yet."));
    // Built in full before the fallback is touched, so a failure above keeps it.
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(root);
    container.setAttribute("data-state", feed.status);
  }

  function mount(container) {
    var id = container.getAttribute("data-crestahq-reviews");
    var api = (container.getAttribute("data-api") || "").replace(/\/+$/, "");
    if (!id || !api) {
      container.setAttribute("data-state", "fallback");
      return;
    }
    container.setAttribute("data-state", "loading");
    fetch(api + FEED_PATH + encodeURIComponent(id), { credentials: "omit" })
      .then(function (res) {
        if (!res.ok) throw new Error("feed HTTP " + res.status);
        return res.json();
      })
      .then(function (feed) {
        if (!feed || feed.version !== 1 || (feed.status !== "ok" && feed.status !== "stale")) {
          throw new Error("feed unavailable");
        }
        injectCss();
        render(container, feed);
      })
      .catch(function () {
        container.setAttribute("data-state", "fallback");
      });
  }

  function start() {
    var nodes = document.querySelectorAll("[data-crestahq-reviews]");
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i].hasAttribute("data-state")) mount(nodes[i]);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
