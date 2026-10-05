import "server-only";

import { apiKeyRef, onApiKeyRevoked } from "@/lib/firestore/api-keys";
import { sweepRevokedKeyProposals } from "@/lib/server/agent-proposals-sweeps";

// Imported for its side effect by every route that revokes a key: the hook
// registry is module-level, so a route that never loads this module would
// revoke the key and leave its pending proposals approvable. An agency key's
// pending rows sit under every sub-account it reached; the sweep finds them
// by key, not by sub-account.
onApiKeyRevoked(async ({ owner, keyId }) => {
  await sweepRevokedKeyProposals({ keyRef: apiKeyRef(owner, keyId) });
});
