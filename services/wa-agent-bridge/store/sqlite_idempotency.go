// Idempotency and the outbound reservation slots are split into their own
// file: they are the only parts of the SQLite store where correctness depends
// on the exact shape of a statement rather than on plain CRUD, and they are
// the part a reviewer needs to read whole.
package store

import (
	"database/sql"
	"time"
)

func (s *SQLite) LookupIdempotency(key string) (string, string, bool, error) {
	var id, jid string
	err := s.db.QueryRow(
		`SELECT msg_id, jid FROM idempotency WHERE key = ?`, key).Scan(&id, &jid)
	if err == sql.ErrNoRows {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return id, jid, true, nil
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
//
// The `jid = excluded.jid` guard is the second crux and it is about a
// DIFFERENT failure. A key is only meaningful for one recipient: reusing
// "turn-1" for a second contact must not reclaim the first contact's row,
// because the reclaim would let the caller believe its key is fresh while the
// row it took over belonged to somebody else. Refusing here (the caller sees
// existingJID != its own) turns a caller bug into a loud 422 instead of a
// silent non-delivery.
func (s *SQLite) ReserveIdempotency(storageKey, jid string, now time.Time) (string, string, bool, error) {
	res, err := s.db.Exec(
		`INSERT INTO idempotency (key, msg_id, jid, reserved_at) VALUES (?, '', ?, ?)
		 ON CONFLICT(key) DO UPDATE SET reserved_at = excluded.reserved_at
		 WHERE idempotency.msg_id = '' AND idempotency.jid = excluded.jid
		   AND idempotency.reserved_at < ?`,
		storageKey, jid, now.Unix(), now.Add(-ReservationLease).Unix())
	if err != nil {
		return "", "", false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return "", "", false, err
	}
	if n == 1 {
		return "", jid, true, nil
	}
	var id, existingJID string
	if err := s.db.QueryRow(
		`SELECT msg_id, jid FROM idempotency WHERE key = ?`, storageKey,
	).Scan(&id, &existingJID); err != nil {
		if err == sql.ErrNoRows {
			// The row vanished between the no-op insert and this read. Fail closed:
			// report "already reserved" so no send happens on an unclear state.
			return "", "", false, nil
		}
		return "", "", false, err
	}
	return id, existingJID, false, nil
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

// ReserveOutboundSlot writes the counted outbound row at reservation time.
// It is an ordinary outbound row, so every volume query below counts it from
// the moment it lands — which is the whole point: budget spent at reservation
// binds across concurrent callers, budget spent after the send does not.
func (s *SQLite) ReserveOutboundSlot(storageKey, jid, consumer string, at time.Time) error {
	_, err := s.db.Exec(
		`INSERT INTO messages (jid, outbound, consumer, msg_id, slot_key, at_unix)
		 VALUES (?, 1, ?, '', ?, ?)`,
		jid, consumer, storageKey, at.Unix())
	return err
}

// ReleaseOutboundSlot returns the budget of a send that provably never left.
//
// It deletes the NEWEST unconfirmed row for the key, never every match. A slot
// stranded by an earlier timeout belongs to a message that may well have been
// delivered, and its budget must stay spent — the same asymmetry
// ReleaseIdempotency documents.
func (s *SQLite) ReleaseOutboundSlot(storageKey string) error {
	_, err := s.db.Exec(
		`DELETE FROM messages WHERE id = (
		   SELECT id FROM messages WHERE slot_key = ? AND msg_id = ''
		   ORDER BY id DESC LIMIT 1)`, storageKey)
	return err
}

// ConfirmOutboundSlot stamps the real message id on a reserved row and clears
// its slot key. No count moves: the row was already counted at reservation, so
// a failure here is cosmetic rather than a blind cap.
func (s *SQLite) ConfirmOutboundSlot(storageKey, messageID string) error {
	_, err := s.db.Exec(
		`UPDATE messages SET msg_id = ?, slot_key = '' WHERE id = (
		   SELECT id FROM messages WHERE slot_key = ? AND msg_id = ''
		   ORDER BY id DESC LIMIT 1)`, messageID, storageKey)
	return err
}
