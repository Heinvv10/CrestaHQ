/* CrestaHQ Google reviews embed — contract: docs/features/gbp-reviews.md
 *
 * Usage:
 *   <div data-crestahq-reviews="PUBLIC_ID" data-api="https://crm.crestahq.com">
 *     <!-- static fallback: shown as-is with JS off or when the feed fails -->
 *     <p>Rated 4.8 on Google — <a href="https://…">read our reviews</a></p>
 *   </div>
 *   <script src="https://crm.crestahq.com/embed/gbp-reviews.js" defer></script>
 *
 * What it does, per container:
 *   1. data-state="loading" — the fallback stays visible.
 *   2. GET {data-api}/api/public/gbp/feed/{id} (no cookies). The page's origin
 *      must be on the widget's allow-list, or the browser is refused.
 *   3. status ok / stale → replace the fallback with the reviews carousel
 *      (stale data carries "Last updated <date>"). Anything else — unavailable,
 *      an HTTP or network error, an unknown contract version — leaves the
 *      fallback untouched and sets data-state="fallback".
 *
 * Feed data only ever reaches the page through textContent, and only http(s)
 * links from the feed are made clickable. Auto-advance runs only when the
 * visitor has not asked for reduced motion, never faster than every 8s, and
 * pauses while the carousel is hovered or focused.
 *
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
      head.appendChild(el("p", "chq-reviews__rating",
        feed.rating.average + " ★ · " + count + (count === 1 ? " review" : " reviews")));
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
    function button(label, symbol, step) {
      var b = el("button", null, symbol);
      b.type = "button";
      b.setAttribute("aria-label", label);
      b.addEventListener("click", function () {
        show(current + step);
      });
      return b;
    }
    var controls = el("div", "chq-reviews__controls");
    controls.appendChild(button("Previous review", "‹", -1));
    controls.appendChild(counter);
    controls.appendChild(button("Next review", "›", 1));
    region.appendChild(controls);
    region.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") show(current + 1);
      else if (e.key === "ArrowLeft") show(current - 1);
    });
    show(0);
    autoAdvance(region, track, function () {
      show(current + 1);
    }, slides.length);
    return region;
  }

  function autoAdvance(region, track, advance, count) {
    var reduce = !window.matchMedia || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || count < 2) return;
    var hovered = false;
    var focused = false;
    function sync() {
      // WAI carousel pattern: no announcements while it rotates on its own.
      track.setAttribute("aria-live", hovered || focused ? "polite" : "off");
    }
    region.addEventListener("mouseenter", function () { hovered = true; sync(); });
    region.addEventListener("mouseleave", function () { hovered = false; sync(); });
    region.addEventListener("focusin", function () { focused = true; sync(); });
    region.addEventListener("focusout", function () { focused = false; sync(); });
    sync();
    setInterval(function () {
      if (!hovered && !focused) advance();
    }, AUTO_ADVANCE_MS);
  }

  function render(container, feed) {
    var root = el("div", "chq-reviews");
    root.appendChild(header(feed));
    var reviews = Array.isArray(feed.reviews) ? feed.reviews : [];
    if (reviews.length === 0) root.appendChild(el("p", "chq-reviews__empty", "No Google reviews yet."));
    else root.appendChild(carousel(reviews));
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
