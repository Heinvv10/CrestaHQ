import "server-only";

/**
 * A process-wide cap on staged-attachment bytes held in memory at once.
 *
 * A staged send reads the whole file into memory (one copy — see
 * `readStaged`) and holds it until Graph has it: up to 100 MB per Cloud
 * document. The app runs as ONE Node process on velo, so without a cap a
 * handful of concurrent large sends is an out-of-memory crash for every
 * tenant at once. With it, a send that cannot get budget within `waitMs`
 * gets a "busy, try again" refusal instead.
 *
 * FIFO: a waiting send is granted before a later one that would happen to
 * fit, so a large file is not starved by a stream of small ones.
 */
export interface ByteBudget {
  /** A release function, or null when `bytes` could not be granted in time. */
  acquire(bytes: number): Promise<(() => void) | null>;
  inFlight(): number;
}

export function createByteBudget(totalBytes: number, waitMs: number): ByteBudget {
  let inFlight = 0;
  const waiters: Array<{ bytes: number; grant: (release: () => void) => void }> = [];

  const releaser = (bytes: number) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight -= bytes;
      while (waiters.length > 0 && inFlight + waiters[0]!.bytes <= totalBytes) {
        const w = waiters.shift()!;
        inFlight += w.bytes;
        w.grant(releaser(w.bytes));
      }
    };
  };

  return {
    inFlight: () => inFlight,
    acquire(bytes) {
      if (bytes > totalBytes) return Promise.resolve(null);
      if (waiters.length === 0 && inFlight + bytes <= totalBytes) {
        inFlight += bytes;
        return Promise.resolve(releaser(bytes));
      }
      return new Promise((resolve) => {
        const waiter = { bytes, grant: (release: () => void) => { clearTimeout(timer); resolve(release); } };
        const timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, waitMs);
        waiters.push(waiter);
      });
    },
  };
}

/**
 * 200 MB: two maximum-size Cloud documents, or many ordinary photos, at once.
 * Measured at ~1.1× the file per send (PR #174), so this bounds staged media
 * at roughly 220 MB of the process. 10 s is long enough to ride out one other
 * large upload finishing, and short enough that the operator is not left
 * watching a spinner.
 */
export const stagedMediaBudget = createByteBudget(200_000_000, 10_000);

/**
 * Decoded-pixel memory for photos being shrunk (image-shrink.ts), kept apart
 * from `stagedMediaBudget`, which holds only file bytes: a shrink reserves
 * from its header what its decode can really use, and never blocks a
 * document send while it runs. 300 MB admits the worst photo it takes (a
 * 50 MP 8-bit RGBA PNG, ~265 MB reserved) or several ordinary ones.
 */
export const IMAGE_DECODE_BUDGET_BYTES = 300_000_000;
export const imageDecodeBudget = createByteBudget(IMAGE_DECODE_BUDGET_BYTES, 10_000);
/** At most two decodes at once: libvips spreads each across every core. */
export const imageDecodeSlots = createByteBudget(2, 10_000);

/**
 * One video transcode at a time, process-wide (video-transcode.ts). This
 * counts transcodes, not bytes: ffmpeg is a child process reading and
 * writing temp files, so neither its file bytes nor its memory (~520 MB RSS
 * measured on a 4K60 source) are held by any ByteBudget here. Allowing one
 * at a time is the only thing that limits that memory. A second send waits
 * 5 s, then is told to retry.
 */
export const videoTranscodeSlots = createByteBudget(1, 5_000);
