package store

import (
	"database/sql"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// SQLite is the production Store. Local disk only: the bridge must not depend
// on a shared database or a network path. Three of the sibling bridge's eight
// documented outages had nothing to do with WhatsApp — they were a shared
// Postgres running out of connection slots and a Tailscale session dropping.
// Depending on nothing but this file removes that entire class.
type SQLite struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  jid       TEXT    NOT NULL,
  outbound  INTEGER NOT NULL,
  consumer  TEXT    NOT NULL DEFAULT '',
  msg_id    TEXT    NOT NULL DEFAULT '',
  at_unix   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_jid_at ON messages(jid, at_unix);
CREATE INDEX IF NOT EXISTS idx_messages_at     ON messages(at_unix);
-- Supports OutboundCountForConsumer's (outbound, consumer, at_unix) filter,
-- which the budget rail runs twice on every single send.
CREATE INDEX IF NOT EXISTS idx_messages_outbound_consumer_at
  ON messages(outbound, consumer, at_unix);

CREATE TABLE IF NOT EXISTS allowlist (
  jid TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS idempotency (
  key         TEXT    PRIMARY KEY,
  msg_id      TEXT    NOT NULL,
  reserved_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS flags (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`

// NOTE: neither `messages` nor `idempotency` is ever pruned, so both grow
// without bound. At the bridge's capped volume that is years away, but a
// retention sweep will eventually be needed.

func OpenSQLite(path string) (*SQLite, error) {
	db, err := sql.Open("sqlite3", path+"?_busy_timeout=5000&_journal_mode=WAL")
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	// A developer's existing db file predates reserved_at, and CREATE TABLE IF
	// NOT EXISTS will not add it. Nothing is deployed yet, so this is only
	// courtesy for local files — but a store that fails to open on a stale
	// schema is a store nobody can debug against.
	if err := addReservedAtColumn(db); err != nil {
		db.Close()
		return nil, err
	}
	return &SQLite{db: db}, nil
}

// addReservedAtColumn is an idempotent migration: it adds idempotency.
// reserved_at when an older file lacks it. Rows predating the column default
// to 0, i.e. immediately past the lease — correct, because any reservation
// that survived the upgrade with no message id is by definition stranded.
func addReservedAtColumn(db *sql.DB) error {
	rows, err := db.Query(`PRAGMA table_info(idempotency)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			cid, notnull, pk int
			name, ctype      string
			dflt             sql.NullString
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return err
		}
		if name == "reserved_at" {
			return rows.Err()
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = db.Exec(
		`ALTER TABLE idempotency ADD COLUMN reserved_at INTEGER NOT NULL DEFAULT 0`)
	return err
}

func (s *SQLite) Close() error { return s.db.Close() }

func (s *SQLite) record(jid string, outbound bool, consumer, msgID string, at time.Time) error {
	flag := 0
	if outbound {
		flag = 1
	}
	_, err := s.db.Exec(
		`INSERT INTO messages (jid, outbound, consumer, msg_id, at_unix) VALUES (?, ?, ?, ?, ?)`,
		jid, flag, consumer, msgID, at.Unix())
	return err
}

func (s *SQLite) RecordInbound(jid string, at time.Time) error {
	return s.record(jid, false, "", "", at)
}

func (s *SQLite) RecordOutbound(jid, consumer, messageID string, at time.Time) error {
	return s.record(jid, true, consumer, messageID, at)
}

func (s *SQLite) HasInboundFrom(jid string) (bool, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(1) FROM messages WHERE jid = ? AND outbound = 0`, jid).Scan(&n)
	return n > 0, err
}

func (s *SQLite) IsAllowlisted(jid string) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(1) FROM allowlist WHERE jid = ?`, jid).Scan(&n)
	return n > 0, err
}

func (s *SQLite) AddAllowlist(jid string) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO allowlist (jid) VALUES (?)`, jid)
	return err
}

func (s *SQLite) RemoveAllowlist(jid string) error {
	_, err := s.db.Exec(`DELETE FROM allowlist WHERE jid = ?`, jid)
	return err
}

func (s *SQLite) OutboundCountForContact(jid string, since time.Time) (int, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(1) FROM messages WHERE jid = ? AND outbound = 1 AND at_unix >= ?`,
		jid, since.Unix()).Scan(&n)
	return n, err
}

func (s *SQLite) OutboundCountTotal(since time.Time) (int, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(1) FROM messages WHERE outbound = 1 AND at_unix >= ?`,
		since.Unix()).Scan(&n)
	return n, err
}

func (s *SQLite) OutboundCountForConsumer(consumer string, since time.Time) (int, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(1) FROM messages WHERE outbound = 1 AND consumer = ? AND at_unix >= ?`,
		consumer, since.Unix()).Scan(&n)
	return n, err
}

// ConsecutiveOutbound counts outbound messages since the contact's most recent
// inbound. Written as one query rather than a scan so the count stays correct
// on a thread with a long history.
func (s *SQLite) ConsecutiveOutbound(jid string) (int, error) {
	var lastInbound sql.NullInt64
	if err := s.db.QueryRow(
		`SELECT MAX(at_unix) FROM messages WHERE jid = ? AND outbound = 0`, jid,
	).Scan(&lastInbound); err != nil {
		return 0, err
	}
	since := int64(0)
	if lastInbound.Valid {
		since = lastInbound.Int64
	}
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(1) FROM messages WHERE jid = ? AND outbound = 1 AND at_unix >= ?`,
		jid, since).Scan(&n)
	return n, err
}

func (s *SQLite) KillState() (bool, error) {
	var v int
	err := s.db.QueryRow(`SELECT value FROM flags WHERE name = 'kill'`).Scan(&v)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return v != 0, err
}

func (s *SQLite) SetKill(on bool) error {
	v := 0
	if on {
		v = 1
	}
	_, err := s.db.Exec(
		`INSERT OR REPLACE INTO flags (name, value) VALUES ('kill', ?)`, v)
	return err
}
