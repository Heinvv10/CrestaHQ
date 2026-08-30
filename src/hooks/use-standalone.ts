"use client";

import { useEffect, useState } from "react";

/**
 * True when running as an INSTALLED PWA (home-screen launch): Chromium
 * reports `display-mode: standalone`; iOS Safari sets `navigator.standalone`.
 * False in any normal browser tab — which is what keeps PWA-only UI
 * adaptations (e.g. the trimmed drawer menu) from touching regular mobile
 * website use.
 *
 * SSR-safe: initial render is `false` everywhere, then flips on mount —
 * so standalone-only adaptations must be progressive (hide/trim extras),
 * never load-bearing.
 */
export function useIsStandalone(): boolean {
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(display-mode: standalone)");
    const compute = () =>
      setStandalone(
        mq.matches ||
          (navigator as unknown as { standalone?: boolean }).standalone ===
            true,
      );
    compute();
    mq.addEventListener("change", compute);
    return () => mq.removeEventListener("change", compute);
  }, []);

  return standalone;
}
