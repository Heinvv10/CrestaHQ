// Idempotency is split into its own file: it is the only part of the SQLite
// store where correctness depends on the exact shape of a statement rather
// than on plain CRUD, and it is the part a reviewer needs to read whole.
package store

import (
	"database/sql"
	"time"
)

func (s *SQLite) LookupIdempotency(key string) (string, bool, error) {
	var id string
	err := s.db.QueryRow(`SELECT msg_id FROM idempotency WHERE key = ?`, key).Scan(&id)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return id, true, nil
}

// ReserveIdempotency claims a key if it is unclaimed, or reclaims one whose
// reservation has outlived ReservationLease without completing. It stays ONE
// statement: the write itself elects the winner, because SQLite serialises it.
// Written this way rather than as SELECT-then-INSERT because that shape only
// pushes the time-of-check/time-of-use race down a layer instead of closing it.
//
// The `msg_id = ”` guard in the WHERE clause is the crux. A completed send
// carries a message id and is therefore NEVER reclaimable, at any age — the
// lease may only ever free a key whose send provably never recorded a result.
func (s *SQLite) ReserveIdempotency(storageKey string, now time.Time) (string, bool, error) {
	res, err := s.db.Exec(
		`INSERT INTO idempotency (key, msg_id, reserved_at) VALUES (?, '', ?)
		 ON CONFLICT(key) DO UPDATE SET reserved_at = excluded.reserved_at
		 WHERE idempotency.msg_id = '' AND idempotency.reserved_at < ?`,
		storageKey, now.Unix(), now.Add(-ReservationLease).Unix())
	if err != nil {
		return "", false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return "", false, err
	}
	if n == 1 {
		return "", true, nil
	}
	var id string
	if err := s.db.QueryRow(
		`SELECT msg_id FROM idempotency WHERE key = ?`, storageKey).Scan(&id); err != nil {
		if err == sql.ErrNoRows {
			// The row vanished between the no-op insert and this read. Fail closed:
			// report "already reserved" so no send happens on an unclear state.
			return "", false, nil
		}
		return "", false, err
	}
	return id, false, nil
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
// The `msg_id = ”` guard means a completed reservation is never released.
func (s *SQLite) ReleaseIdempotency(storageKey string) error {
	_, err := s.db.Exec(
		`DELETE FROM idempotency WHERE key = ? AND msg_id = ''`, storageKey)
	return err
}

// SaveIdempotency upgrades a reservation this caller owns into a replayable
// result. The `msg_id = ”` predicate means it can only ever complete a row
// that holds an OPEN reservation: a save against a key nobody reserved, or
// against one already completed, changes nothing and returns
// ErrNoReservation rather than fabricating a completed send.
func (s *SQLite) SaveIdempotency(key, messageID string) error {
	res, err := s.db.Exec(
		`UPDATE idempotency SET msg_id = ? WHERE key = ? AND msg_id = ''`, messageID, key)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNoReservation
	}
	return nil
}
