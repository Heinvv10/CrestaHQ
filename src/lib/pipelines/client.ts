import type { PipelineDoc } from "@/types/deals";

/**
 * Load a sub-account's pipelines through the Admin-SDK route (the
 * subcollection is server-only at the rules level). Throws on any failure
 * so the caller can keep its last-known list and say so — a swallowed
 * error here would silently hide every non-default pipeline's deals.
 */
export async function fetchPipelines(subAccountId: string): Promise<PipelineDoc[]> {
  const res = await fetch(`/api/sub-accounts/${subAccountId}/pipelines`);
  if (!res.ok) throw new Error(`Couldn't load pipelines (HTTP ${res.status}).`);
  const data = (await res.json()) as { pipelines?: PipelineDoc[] };
  return data.pipelines ?? [];
}
