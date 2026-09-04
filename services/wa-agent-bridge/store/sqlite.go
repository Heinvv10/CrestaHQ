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

-- jid binds a key to ONE recipient. Without it a consumer reusing "turn-1"
-- for a second contact gets the FIRST contact's message id back as a
-- duplicate and its second message is never sent — silent non-delivery.
CREATE TABLE IF NOT EXISTS idempotency (
  key         TEXT    PRIMARY KEY,
  msg_id      TEXT    NOT NULL,
  jid         TEXT    NOT NULL DEFAULT '',
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
	// synchronous=FULL, not WAL's default NORMAL. Under NORMAL a power loss can
	// lose the last committed transactions, and the transactions this store
	// commits last are idempotency rows: losing one re-opens a key whose message
	// was already delivered, so the caller's next retry double-messages a real
	// person. The cost is an fsync per commit at a volume capped at 150 sends a
	// day, which is nothing.
	db, err := sql.Open("sqlite3",
		path+"?_busy_timeout=5000&_journal_mode=WAL&_synchronous=FULL")
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
	for _, col := range []struct{ name, ddl string }{
		{"reserved_at", `ALTER TABLE idempotency ADD COLUMN reserved_at INTEGER NOT NULL DEFAULT 0`},
		{"jid", `ALTER TABLE idempotency ADD COLUMN jid TEXT NOT NULL DEFAULT ''`},
	} {
		if err := addIdempotencyColumn(db, col.name, col.ddl); err != nil {
			db.Close()
			return nil, err
		}
	}
	return &SQLite{db: db}, nil
}

// addIdempotencyColumn is an idempotent migration: it runs ddl when the
// idempotency table lacks the named column.
//
// reserved_at rows predating the column default to 0, i.e. immediately past
// the lease — correct, because any reservation that survived the upgrade with
// no message id is by definition stranded. jid rows predating the column
// default to "", which matches no real JID, so a legacy key can never be
// reclaimed for a contact it was not bound to. That is the fail-closed
// direction: the caller gets a loud refusal rather than a silent takeover.
func addIdempotencyColumn(db *sql.DB, column, ddl string) error {
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
		if name == column {
			return rows.Err()
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = db.Exec(ddl)
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

// LastInboundAt reports when anyone last messaged the number, zero when nobody
// ever has. Served by idx_messages_at.
func (s *SQLite) LastInboundAt() (time.Time, error) {
	var at sql.NullInt64
	if err := s.db.QueryRow(
		`SELECT MAX(at_unix) FROM messages WHERE outbound = 0`).Scan(&at); err != nil {
		return time.Time{}, err
	}
	if !at.Valid {
		return time.Time{}, nil
	}
	return time.Unix(at.Int64, 0), nil
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
