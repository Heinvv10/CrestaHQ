export type VoiceClientModule = typeof import("@elevenlabs/client");

/** Keep the sizeable voice SDK off typed-chat pages while still evaluating it
 * before the visitor's mic gesture (the SDK installs its iOS audio unlock hook
 * when this module resolves). */
export function loadVoiceClient(): Promise<VoiceClientModule> {
  return import("@elevenlabs/client");
}
