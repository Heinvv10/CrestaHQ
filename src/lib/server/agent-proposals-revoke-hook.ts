import "server-only";

import { onApiKeyRevoked } from "@/lib/firestore/api-keys";
import { sweepRevokedKeyProposals } from "@/lib/server/agent-proposals";

// Imported for its side effect by every route that revokes a key: the hook
// registry is module-level, so a route that never loads this module would
// revoke the key and leave its pending proposals approvable.
onApiKeyRevoked(async ({ subAccountId, keyId }) => {
  await sweepRevokedKeyProposals({ subAccountId, keyId });
});
