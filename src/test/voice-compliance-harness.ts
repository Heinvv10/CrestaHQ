import { vi } from "vitest";

import type { Contact } from "@/types/contacts";
import type { VoiceChannelConfig } from "@/types/ai";

/**
 * Shared test harness for `src/lib/comms/voice/outbound-compliance.ts`.
 *
 * The gate's tests live in two files (identity/consent/country/scrub vs the
 * timezone window + caps) to stay under the 300-line file cap; both need the
 * same Firestore + usage-meter + scrub-provider doubles, so they live here
 * once. Vitest isolates module state per test file, so each file gets a fresh
 * copy of the stores and spies.
 *
 * Deliberately NOT mocked (and so not present here): phone parsing, the
 * country→timezone table, and the window math. Stubbing those would make the
 * timezone assertions meaningless.
 */

// ---- Firestore fake (the rolling-24h voiceCalls query) ----------------

/** Docs the fake `voiceCalls` query returns. Reassign per test. */
export let voiceCallDocs: Array<{ callerPhone: string | null }> = [];
export function setVoiceCallDocs(rows: Array<{ callerPhone: string | null }>) {
  voiceCallDocs = rows;
}

/** When true the Firestore read rejects (exercises the fail-open path). */
export let firestoreThrows = false;
export function setFirestoreThrows(v: boolean) {
  firestoreThrows = v;
}

export function fakeDb() {
  return {
    collection: () => {
      const q = {
        where: () => q,
        get: async () => {
          if (firestoreThrows) throw new Error("firestore blip");
          return {
            size: voiceCallDocs.length,
            docs: voiceCallDocs.map((d) => ({ data: () => d })),
          };
        },
      };
      return q;
    },
  };
}

// ---- external services ------------------------------------------------

export const checkQuota = vi.fn(async () => ({ allowed: true }));
export const scrub = vi.fn<
  (e164: string) => Promise<{ allowed: boolean; reasons: string[] }>
>(async () => ({ allowed: true, reasons: [] }));

// ---- fixtures ---------------------------------------------------------

export const AU_PHONE = "+61412345678";
export const US_PHONE = "+14155552671";

export function contact(over: Partial<Contact> = {}): Contact {
  return {
    id: "c1",
    name: "Jane",
    phone: AU_PHONE,
    email: "jane@example.com",
    ...over,
  } as Contact;
}

export function voice(
  over: Partial<VoiceChannelConfig> = {}
): VoiceChannelConfig {
  return {
    outboundWindow: null,
    outboundPerMinuteCap: 100,
    outboundDailyCap: 200,
    outboundPerNumberPerDay: 5,
    allowedCountries: null,
    ...over,
  } as VoiceChannelConfig;
}

export interface RunOverrides {
  contact?: Contact;
  voice?: VoiceChannelConfig;
  consentAck?: boolean;
  agentTimezone?: string;
  subAccountId?: string;
}

/** Builds the gate's input. Each call gets a unique sub-account id unless one
 *  is given — the per-minute burst limiter is module-level state, so sharing
 *  an id across unrelated tests would leak. */
let saSeq = 0;
export function gateInput(over: RunOverrides = {}) {
  return {
    subAccountId: over.subAccountId ?? `sa_${++saSeq}`,
    contact: over.contact ?? contact(),
    voice: over.voice ?? voice(),
    agentTimezone: over.agentTimezone ?? "Australia/Sydney",
    consentAck: over.consentAck ?? true,
  };
}

/** Reset stores + spies. Call from the test file's beforeEach. */
export function resetHarness() {
  voiceCallDocs = [];
  firestoreThrows = false;
  checkQuota.mockResolvedValue({ allowed: true });
  scrub.mockResolvedValue({ allowed: true, reasons: [] });
}
