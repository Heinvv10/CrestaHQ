import "server-only";

import { onApiKeyRevoked } from "@/lib/firestore/api-keys";
import { sweepRevokedKeyProposals } from "@/lib/server/agent-proposals-sweeps";

// Imported for its side effect by every route that revokes a key: the hook
// registry is module-level, so a route that never loads this module would
// revoke the key and leave its pending proposals approvable. An agency key
// cannot propose anything yet (every transport refuses it until A3b), so it
// has no rows to sweep.
onApiKeyRevoked(async ({ owner, keyId }) => {
  if (owner.level !== "sub-account") return;
  await sweepRevokedKeyProposals({ subAccountId: owner.subAccountId, keyId });
});
