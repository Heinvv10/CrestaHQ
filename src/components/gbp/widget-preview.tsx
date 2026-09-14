"use client";

import { useEffect, useRef, useState } from "react";

/**
 * "Preview (saved settings)" on the widget card: the REAL embed script, run
 * against this widget's public feed from the dashboard.
 *
 * The request is same-origin, and a browser sends no `Origin` header on a
 * same-origin GET (Fetch spec: only CORS-tainted requests and non-GET/HEAD
 * methods carry one). The feed serves a request without `Origin` — so the
 * preview needs no allow-list entry for the dashboard, and the allow-list is
 * not loosened. A switched-off widget 404s here as it does on a site.
 *
 * The container is created only once the script has loaded, so the script's
 * own load-time scan never picks it up with a plain fetch; it is handed to
 * `window.crestahqReviews.mount`, which revalidates the feed — a saved layout
 * change shows at once, not after the feed's 60 s max-age.
 */

const SRC = "/embed/gbp-reviews.js";
type Hook = { mount: (container: Element) => void };
type State = "loading" | "ok" | "stale" | "fallback" | "script_error";

function loadEmbed(): Promise<Hook> {
  const w = window as unknown as { crestahqReviews?: Hook };
  if (w.crestahqReviews) return Promise.resolve(w.crestahqReviews);
  return new Promise((resolve, reject) => {
    let script = document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = SRC;
      script.async = true;
      document.head.append(script);
    }
    const tag = script;
    tag.addEventListener("load", () => (w.crestahqReviews ? resolve(w.crestahqReviews) : reject(new Error("embed hook missing"))));
    tag.addEventListener("error", () => {
      tag.remove(); // so the next preview tries again
      reject(new Error("embed script failed to load"));
    });
  });
}

/** `version` changes whenever a saved setting that changes the picture does. */
export function WidgetPreview({ publicId, version }: { publicId: string; version: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let live = true;
    setState("loading");
    const box = document.createElement("div");
    box.setAttribute("data-crestahq-reviews", publicId);
    box.setAttribute("data-api", window.location.origin);
    const observer = new MutationObserver(() => {
      const s = box.getAttribute("data-state");
      if (live && (s === "ok" || s === "stale" || s === "fallback")) setState(s);
    });
    observer.observe(box, { attributes: true, attributeFilter: ["data-state"] });
    loadEmbed()
      .then((hook) => {
        if (!live) return;
        el.replaceChildren(box);
        hook.mount(box);
      })
      .catch((err: unknown) => {
        console.warn("[gbp/widget-preview] embed script unavailable:", err instanceof Error ? err.message : "unknown");
        if (live) setState("script_error");
      });
    return () => {
      live = false;
      observer.disconnect();
      el.replaceChildren();
    };
  }, [publicId, version]);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Preview (saved settings)</p>
      {state === "loading" && (
        <p className="text-xs text-muted-foreground" data-testid="gbp-widget-preview-loading">Loading preview…</p>
      )}
      {state === "fallback" && (
        <p className="text-xs text-muted-foreground" data-testid="gbp-widget-preview-fallback">
          Nothing to preview: the widget is switched off, or the feed has no reviews to show yet. Sites show their static content.
        </p>
      )}
      {state === "script_error" && (
        <p className="text-xs text-destructive" data-testid="gbp-widget-preview-error">The preview could not load the embed script.</p>
      )}
      <div ref={host} hidden={state !== "ok" && state !== "stale"} className="overflow-x-auto rounded-lg border p-3" data-testid="gbp-widget-preview" />
    </div>
  );
}
