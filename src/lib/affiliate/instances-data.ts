// Stub — see publish/README.md. The kept heartbeat receiver
// (api/v1/leadstack/heartbeat) imports sendNewInstanceAlert; it's a no-op
// off the mothership (the call is also gated on LANDING_VARIANT there).
export async function sendNewInstanceAlert(_params: {
  instanceId: string;
  ownerEmail: string;
  platform: string | null;
  version: string | null;
  licenseState: string | null;
}): Promise<void> {
  // no-op
}
