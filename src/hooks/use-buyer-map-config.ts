"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebaseDb, isFirebaseConfigured } from "@/lib/firebase/client";
import {
  coerceBuyerMapConfig,
  BUYER_MAP_DEFAULTS,
  type BuyerMapConfig,
} from "@/lib/buyer-map-config";

export interface BuyerMapConfigState extends BuyerMapConfig {
  /** False until the first Firestore read resolves. */
  hydrated: boolean;
}

/**
 * Live subscription to the buyer-map config (`appConfig/buyerWorldMap`).
 * Mirrors {@link useExitIntentConfig} — used by the /agency/landing editor so
 * the preview reflects a save immediately. The PUBLIC landing does NOT use
 * this hook; it reads the config server-side (cached) to avoid a layout flash.
 * Falls back to the shipped defaults when Firebase is unconfigured or the doc
 * is missing.
 */
export function useBuyerMapConfig(): BuyerMapConfigState {
  const [state, setState] = useState<BuyerMapConfigState>({
    ...BUYER_MAP_DEFAULTS,
    hydrated: false,
  });

  useEffect(() => {
    const fallback = () => setState({ ...BUYER_MAP_DEFAULTS, hydrated: true });
    if (!isFirebaseConfigured()) return fallback();

    let db;
    try {
      db = getFirebaseDb();
    } catch {
      return fallback();
    }

    const unsub = onSnapshot(
      doc(db, "appConfig/buyerWorldMap"),
      (snap) =>
        setState({
          ...coerceBuyerMapConfig(
            snap.data() as Partial<BuyerMapConfig> | undefined,
          ),
          hydrated: true,
        }),
      fallback,
    );
    return () => unsub();
  }, []);

  return state;
}
