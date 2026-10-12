/**
 * A stand-in for `@twilio/voice-sdk` at the module seam, for the dialer's
 * jsdom tests. It mirrors the two SDK behaviours the call bar depends on:
 * `connect()` resolves with the Call before it is answered, and destroying
 * the Device disconnects its call, which then emits "disconnect".
 *
 * Use: `vi.mock("@twilio/voice-sdk", async () => (await import("@/test/fake-voice-sdk")).fakeVoiceSdkModule())`.
 */

type Handler = (...args: unknown[]) => void;

class Emitter {
  private handlers = new Map<string, Handler[]>();
  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

export class FakeCall extends Emitter {
  disconnectCalls = 0;
  muted = false;
  digits: string[] = [];
  disconnect() {
    this.disconnectCalls++;
    if (this.disconnectCalls === 1) this.emit("disconnect");
  }
  mute(shouldMute: boolean) {
    this.muted = shouldMute;
  }
  isMuted() {
    return this.muted;
  }
  sendDigits(digits: string) {
    this.digits.push(digits);
  }
}

export class FakeDevice extends Emitter {
  destroyCalls = 0;
  call = new FakeCall();
  connectOpts: { params: Record<string, string> } | null = null;
  constructor(public token: string) {
    super();
    voiceSdk.devices.push(this);
  }
  connect(opts: { params: Record<string, string> }) {
    this.connectOpts = opts;
    return voiceSdk.connect(this);
  }
  destroy() {
    this.destroyCalls++;
    this.call.disconnect();
  }
}

export const voiceSdk = {
  /** How many times the SDK module itself was loaded. */
  loads: 0,
  devices: [] as FakeDevice[],
  /** What `device.connect()` does; replace per test (pending, rejecting…). */
  connect: (device: FakeDevice): Promise<FakeCall> => Promise.resolve(device.call),
  reset() {
    this.devices = [];
    this.connect = (device) => Promise.resolve(device.call);
  },
  get device(): FakeDevice {
    const last = this.devices.at(-1);
    if (!last) throw new Error("no Device was constructed");
    return last;
  },
};

export function fakeVoiceSdkModule() {
  voiceSdk.loads++;
  return { Device: FakeDevice };
}
