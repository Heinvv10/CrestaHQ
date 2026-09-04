// Idempotency and the outbound reservation slots live here rather than in
// memory.go: they are the only parts of the Memory store where correctness
// depends on the exact shape of a critical section rather than on plain
// bookkeeping, and they mirror sqlite_idempotency.go one for one.
package store

import "time"

func (m *Memory) LookupIdempotency(key string) (string, string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.idem[key]
	return r.msgID, r.jid, ok, nil
}

// ReserveIdempotency claims a key if it is unclaimed, or reclaims one whose
// reservation has outlived ReservationLease without completing. The read and
// the write happen in ONE critical section: splitting them would reintroduce
// the very race the reservation exists to close.
//
// A key bound to a DIFFERENT recipient is never reclaimable either — see the
// jid guard below.
//
// A COMPLETED send (non-empty msgID) is never reclaimable at any age. That
// guard is the whole safety of the lease: expiry may only ever free a key
// whose message provably never got an id recorded, never a key whose message
// was actually sent.
func (m *Memory) ReserveIdempotency(storageKey, jid string, now time.Time) (string, string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.idem[storageKey]
	if ok {
		// A key bound to another recipient is never reclaimable, at any age.
		// Reclaiming it would hand this caller a row that belongs to a
		// different contact; refusing turns a caller bug into a loud error
		// instead of a message that is never sent.
		if r.jid != jid {
			return r.msgID, r.jid, false, nil
		}
		if !(r.msgID == "" && r.reservedAt.Before(now.Add(-ReservationLease))) {
			return r.msgID, r.jid, false, nil
		}
	}
	m.idem[storageKey] = reservation{jid: jid, reservedAt: now}
	return "", jid, true, nil
}

// ReleaseIdempotency drops a reservation whose send will never complete.
//
// Call this ONLY when the provider definitively rejected the request and the
// message never left — a validation error, an authentication failure, a
// refusal returned before anything went on the wire.
//
// NEVER call it on a timeout. A timed-out send may well have been delivered;
// releasing the key there is the one path that genuinely double-sends a real
// customer. Leave a timed-out reservation alone and let ReservationLease
// expire it, which is exactly why the lease exists.
//
// A completed reservation (one carrying a message id) is never released.
func (m *Memory) ReleaseIdempotency(storageKey string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.idem[storageKey]; ok && r.msgID == "" {
		delete(m.idem, storageKey)
	}
	return nil
}

// SaveIdempotency upgrades a reservation this caller owns into a replayable
// result. It refuses to write against a key holding no open reservation:
// otherwise a stray save could fabricate a completed send for a key nobody
// ever reserved.
func (m *Memory) SaveIdempotency(key, messageID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.idem[key]
	if !ok || r.msgID != "" {
		return ErrNoReservation
	}
	r.msgID = messageID
	m.idem[key] = r
	return nil
}
