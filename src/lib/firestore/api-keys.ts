import "server-only";

import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type {
  ApiKeyDoc,
  ApiKeyMode,
  ApiKeyResponse,
  ApiKeyScope,
} from "@/types/api";

/**
 * Server-only Admin-SDK CRUD for `subAccounts/{subAccountId}/apiKeys/{keyId}`
 * and `agencies/{agencyId}/apiKeys/{keyId}` (agency keys).
 *
 * Firestore rules deny all client reads + writes on both collections
 * (see firestore.rules; the agency one falls to the default deny). The
 * operator UI hits the `/api/sub-accounts/{id}/api-keys` and
 * `/api/agency/api-keys` routes which run through this helper.
 *
 * `hashedSecret` never leaves the server. `docToResponse()` strips it
 * before any value is returned to a client.
 */

function tsToDate(ts: Timestamp | Date | null | undefined): Date | null {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  if (typeof (ts as Timestamp).toDate === "function") {
    return (ts as Timestamp).toDate();
  }
  return null;
}

/** The collection a key lives in; its level is never read from the doc. */
export type ApiKeyOwner =
  | { level: "sub-account"; subAccountId: string }
  | { level: "agency"; agencyId: string };

function keysCollection(owner: ApiKeyOwner) {
  return owner.level === "agency"
    ? getAdminDb().collection("agencies").doc(owner.agencyId).collection("apiKeys")
    : getAdminDb().collection("subAccounts").doc(owner.subAccountId).collection("apiKeys");
}

/** `subAccounts/{id}/apiKeys/{keyId}` or `agencies/{id}/apiKeys/{keyId}`;
 *  anything else (an `apiKeys` collection elsewhere) is no key at all. */
function ownerFromPath(path: string): ApiKeyOwner | null {
  const [parent, id, coll, keyId, ...rest] = path.split("/");
  if (!id || coll !== "apiKeys" || !keyId || rest.length > 0) return null;
  if (parent === "subAccounts") return { level: "sub-account", subAccountId: id };
  if (parent === "agencies") return { level: "agency", agencyId: id };
  return null;
}

/** An agency key's agency is its path; a sub-account key's is stamped data. */
function ownerFields(owner: ApiKeyOwner, agencyId: string) {
  return owner.level === "agency"
    ? { level: "agency" as const, subAccountId: null, agencyId: owner.agencyId }
    : { level: "sub-account" as const, subAccountId: owner.subAccountId, agencyId };
}

function snapToDoc(
  owner: ApiKeyOwner,
  id: string,
  data: FirebaseFirestore.DocumentData,
): ApiKeyDoc {
  return {
    id,
    ...ownerFields(owner, data.agencyId),
    name: data.name,
    mode: data.mode,
    prefix: data.prefix,
    hashedSecret: data.hashedSecret,
    scopes: data.scopes ?? [],
    defaultVersion:
      typeof data.defaultVersion === "string" ? data.defaultVersion : undefined,
    enrolmentCapPerHour:
      typeof data.enrolmentCapPerHour === "number"
        ? data.enrolmentCapPerHour
        : undefined,
    createdByUid: data.createdByUid,
    createdAt: tsToDate(data.createdAt) ?? new Date(0),
    lastUsedAt: tsToDate(data.lastUsedAt),
    revokedAt: tsToDate(data.revokedAt),
    revokedByUid: data.revokedByUid ?? null,
  };
}

/**
 * Strip the secret hash before sending to a client. `secret` is added by
 * the caller exactly once — in the create response, after a fresh mint.
 */
export function docToResponse(doc: ApiKeyDoc): ApiKeyResponse {
  return {
    id: doc.id,
    name: doc.name,
    mode: doc.mode,
    prefix: doc.prefix,
    scopes: doc.scopes,
    defaultVersion: doc.defaultVersion,
    createdByUid: doc.createdByUid,
    createdAt: doc.createdAt.toISOString(),
    lastUsedAt: doc.lastUsedAt ? doc.lastUsedAt.toISOString() : null,
    revokedAt: doc.revokedAt ? doc.revokedAt.toISOString() : null,
  };
}

export interface CreateApiKeyInput {
  owner: ApiKeyOwner;
  agencyId: string;
  name: string;
  mode: ApiKeyMode;
  prefix: string;
  hashedSecret: string;
  scopes: ApiKeyScope[];
  /**
   * API version this key is pinned to. The route stamps `LATEST_API_VERSION`
   * at mint so the key locks in the current shape; future breaking changes
   * ship as new versions without rolling over existing integrations.
   */
  defaultVersion: string;
  createdByUid: string;
}

export async function createApiKey(
  input: CreateApiKeyInput,
): Promise<ApiKeyDoc> {
  const ref = keysCollection(input.owner).doc();
  const stamp = ownerFields(input.owner, input.agencyId);

  const now = new Date();
  await ref.set({
    subAccountId: stamp.subAccountId,
    agencyId: stamp.agencyId,
    name: input.name,
    mode: input.mode,
    prefix: input.prefix,
    hashedSecret: input.hashedSecret,
    scopes: input.scopes,
    defaultVersion: input.defaultVersion,
    createdByUid: input.createdByUid,
    createdAt: FieldValue.serverTimestamp(),
    lastUsedAt: null,
    revokedAt: null,
    revokedByUid: null,
  });

  return {
    id: ref.id,
    ...stamp,
    name: input.name,
    mode: input.mode,
    prefix: input.prefix,
    hashedSecret: input.hashedSecret,
    scopes: input.scopes,
    defaultVersion: input.defaultVersion,
    createdByUid: input.createdByUid,
    // serverTimestamp() resolves to "now" on Firestore's clock; we return
    // the local clock for the create response — close enough, and a
    // subsequent list read will surface the real server time. The doc itself
    // carries the authoritative timestamp.
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
    revokedByUid: null,
  };
}

export async function listApiKeys(
  owner: ApiKeyOwner,
  opts: { mode?: ApiKeyMode; includeRevoked?: boolean } = {},
): Promise<ApiKeyDoc[]> {
  let q: FirebaseFirestore.Query = keysCollection(owner);
  if (opts.mode) q = q.where("mode", "==", opts.mode);
  const snap = await q.orderBy("createdAt", "desc").get();
  const docs = snap.docs.map((d) => snapToDoc(owner, d.id, d.data()));
  return opts.includeRevoked
    ? docs
    : docs.filter((d) => d.revokedAt === null);
}

export async function getApiKey(
  owner: ApiKeyOwner,
  keyId: string,
): Promise<ApiKeyDoc | null> {
  const snap = await keysCollection(owner).doc(keyId).get();
  if (!snap.exists) return null;
  return snapToDoc(owner, snap.id, snap.data()!);
}

/**
 * Registered by the Agent API's proposal layer
 * (`lib/server/agent-proposals-revoke-hook.ts`, which the revoke route
 * imports) so revoking a key also sweeps its `pending` `agentProposals` rows
 * to `rejected`. `revokeApiKey` calls every registered hook after the revoke
 * write, ignoring hooks that throw so a proposal-sweep failure never blocks
 * the revoke itself.
 */
type KeyRevokeHook = (input: {
  owner: ApiKeyOwner;
  keyId: string;
  revokedByUid: string;
}) => Promise<void>;
const keyRevokeHooks: KeyRevokeHook[] = [];

export function onApiKeyRevoked(hook: KeyRevokeHook): void {
  keyRevokeHooks.push(hook);
}

export async function revokeApiKey(
  owner: ApiKeyOwner,
  keyId: string,
  revokedByUid: string,
): Promise<void> {
  await keysCollection(owner)
    .doc(keyId)
    .set(
      {
        revokedAt: FieldValue.serverTimestamp(),
        revokedByUid,
      },
      { merge: true },
    );

  for (const hook of keyRevokeHooks) {
    try {
      await hook({ owner, keyId, revokedByUid });
    } catch (err) {
      console.error(
        `[api-keys] revoke hook failed level=${owner.level} key=${keyId} kind=${err instanceof Error ? err.name : typeof err}`,
      );
    }
  }
}

/**
 * Used by slice 2 (auth middleware). Looks up a candidate key by prefix
 * across every sub-account's and agency's apiKeys subcollection via a
 * collection-group query; the key's level and owner come from the doc path.
 * The caller MUST then constant-time-compare the SHA-256 hash
 * before granting access — prefix alone is not a credential.
 *
 * Requires the `apiKeys.prefix` COLLECTION_GROUP field override declared
 * in firestore.indexes.json (deployed via
 * `firebase deploy --only firestore:rules,firestore:indexes`).
 */
export async function findApiKeyByPrefix(
  prefix: string,
): Promise<ApiKeyDoc | null> {
  const snap = await getAdminDb()
    .collectionGroup("apiKeys")
    .where("prefix", "==", prefix)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0]!;
  const owner = ownerFromPath(doc.ref.path);
  return owner ? snapToDoc(owner, doc.id, doc.data()) : null;
}

/**
 * Bump `lastUsedAt` after a successful auth. Fire-and-forget — failure to
 * write the bump must not block the API request. Slice 2 calls this from
 * the auth middleware via `void` (no await).
 */
export async function bumpApiKeyLastUsed(
  owner: ApiKeyOwner,
  keyId: string,
): Promise<void> {
  await keysCollection(owner)
    .doc(keyId)
    .set({ lastUsedAt: FieldValue.serverTimestamp() }, { merge: true });
}
