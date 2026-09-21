"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { MediaAssetDoc, MediaFolderDoc } from "@/types/media";

/**
 * Live view of one sub-account's Media Library. Both subcollections are
 * loaded whole, ordered by `createdAt` alone (no composite index); folder
 * scoping, search and type filters happen client-side — a library is small.
 * A listener failure is reported as `error`, never as an empty library.
 */
export function useMediaLibrary(subAccountId: string) {
  const [assets, setAssets] = useState<MediaAssetDoc[]>([]);
  const [folders, setFolders] = useState<MediaFolderDoc[]>([]);
  const [assetsReady, setAssetsReady] = useState(false);
  const [foldersReady, setFoldersReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!subAccountId) return;
    setError(null);
    const db = getFirebaseDb();
    const unsubAssets = onSnapshot(
      query(collection(db, `subAccounts/${subAccountId}/media`), orderBy("createdAt", "desc")),
      (snap) => {
        setAssets(snap.docs.map((d) => ({ ...(d.data() as MediaAssetDoc), id: d.id })));
        setAssetsReady(true);
      },
      (err) => setError(err),
    );
    const unsubFolders = onSnapshot(
      query(collection(db, `subAccounts/${subAccountId}/mediaFolders`), orderBy("createdAt", "asc")),
      (snap) => {
        setFolders(snap.docs.map((d) => ({ ...(d.data() as MediaFolderDoc), id: d.id })));
        setFoldersReady(true);
      },
      (err) => setError(err),
    );
    return () => {
      unsubAssets();
      unsubFolders();
    };
  }, [subAccountId]);

  return { assets, folders, error, hydrated: assetsReady && foldersReady };
}
