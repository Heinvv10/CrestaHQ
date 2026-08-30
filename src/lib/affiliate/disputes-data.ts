// Stub — see publish/README.md. Only leadstack-internal code (the agency
// Disputes tab, itself stubbed) imports this.
export interface DisputeEvidenceField {
  label: string;
  value: string;
}

export interface DisputeRow {
  disputeId: string;
  status: "disputed" | "revoked";
  buyerEmail: string | null;
  githubUsername: string | null;
  amountCents: number | null;
  reason: string | null;
  evidenceDueByMs: number | null;
  revokeOutcome: string | null;
  purchaseSessionId: string | null;
  stripeDashboardUrl: string;
  createdAtMs: number | null;
  evidence: DisputeEvidenceField[];
}

export async function listAllDisputes(): Promise<DisputeRow[]> {
  return [];
}

export interface DisputeAlertRecipients {
  primary: string | null;
  extraEmails: string[];
}

export async function getDisputeAlertRecipients(): Promise<DisputeAlertRecipients> {
  return { primary: null, extraEmails: [] };
}
