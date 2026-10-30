/**
 * Every outbound HTTP call in this service (QContact reads, LeadStack
 * upsert/deal/stage calls) must carry an abort signal — an unbounded fetch
 * can hang past the next timer tick, and a stale run holding the lock file
 * (see run.ts's acquireLock) blocks every run after it until this fires.
 */
export const FETCH_TIMEOUT_MS = 30_000;
