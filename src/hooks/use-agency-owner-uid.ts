"use client";

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";

/**
 * The deployment's agency-owner uid, read once from appConfig/main
 * (readable by any active member; one agency per deployment in v1).
 *
 * Used to HIDE the owner's implicit membership row from client-facing
 * rosters and pickers — the owner holds a real membership row in every
 * sub-account (it powers their workspace switcher), but platform staff
 * aren't colleagues: a client shouldn't see their provider in the team
 * list, be able to remove them, or pick them as a booking host.
 *
 * FAIL-OPEN by design: returns null while loading and on any read error,
 * and consumers treat null as "filter nothing" — worst case the owner row
 * shows (the old behavior). A roster must never blank out on a blip.
 */
export function useAgencyOwnerUid(): string | null {
  const [ownerUid, setOwnerUid] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDoc(doc(getFirebaseDb(), "appConfig", "main"))
      .then((snap) => {
        if (cancelled) return;
        const v = snap.data()?.firstAgencyOwnerUid;
        setOwnerUid(typeof v === "string" && v.length > 0 ? v : null);
      })
      .catch(() => {
        /* fail open — leave null */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return ownerUid;
}
