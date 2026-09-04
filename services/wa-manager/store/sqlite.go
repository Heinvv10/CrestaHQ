// Package store persists the manager's own state: which tenants exist, which
// port each was allocated, and an append-only log of what happened to them.
//
// It holds NO message content. The manager is a supervisor and a view; it has
// even less reason than the bridge to see a message body, and the same POPIA
// constraint applies.
package store

import (
	"database/sql"
	"fmt"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

type State string

const (
	StateProvisioned State = "provisioned"
	StatePairing     State = "pairing"
	StateRunning     State = "running"
	StateLoggedOut   State = "logged_out"
	StateStopped     State = "stopped"
)

// Tenant is one WhatsApp number and the bridge instance that serves it.
//
// ID is OPAQUE — the manager deliberately does not know what a LeadStack
// sub-account is, so that a second consumer (a GHL listing, say) is a consumer
// rather than a rewrite.
type Tenant struct {
	ID          string
	DisplayName string
	Instance    string // systemd instance name, e.g. "blitz"
	Port        int
	State       State
	Phone       string // filled once paired; empty before
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type Event struct {
	Kind   string
	Detail string
	At     time.Time
}

type Store struct{ db *sql.DB }

const schema = `
CREATE TABLE IF NOT EXISTS tenants (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  instance     TEXT NOT NULL UNIQUE,
  port         INTEGER NOT NULL UNIQUE,
  state        TEXT NOT NULL,
  phone        TEXT NOT NULL DEFAULT '',
  created_unix INTEGER NOT NULL,
  updated_unix INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '',
  at_unix   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_tenant ON events(tenant_id, id DESC);
`

func Open(path string) (*Store, error) {
	// synchronous=FULL for the same reason the bridge uses it: a power loss
	// that loses the last write here loses a port allocation or a tenant, and
	// a tenant whose row vanished still has a running unit on disk.
	db, err := sql.Open("sqlite3", path+"?_busy_timeout=5000&_journal_mode=WAL&_synchronous=FULL")
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) CreateTenant(t Tenant) error {
	now := t.CreatedAt
	if now.IsZero() {
		now = time.Now()
	}
	_, err := s.db.Exec(
		`INSERT INTO tenants (id, display_name, instance, port, state, phone, created_unix, updated_unix)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ID, t.DisplayName, t.Instance, t.Port, string(t.State), t.Phone, now.Unix(), now.Unix())
	return err
}

func (s *Store) GetTenant(id string) (Tenant, error) {
	var t Tenant
	var created, updated int64
	var state string
	err := s.db.QueryRow(
		`SELECT id, display_name, instance, port, state, phone, created_unix, updated_unix
		 FROM tenants WHERE id = ?`, id).
		Scan(&t.ID, &t.DisplayName, &t.Instance, &t.Port, &state, &t.Phone, &created, &updated)
	if err != nil {
		return Tenant{}, err
	}
	t.State = State(state)
	t.CreatedAt, t.UpdatedAt = time.Unix(created, 0), time.Unix(updated, 0)
	return t, nil
}

func (s *Store) ListTenants() ([]Tenant, error) {
	rows, err := s.db.Query(
		`SELECT id, display_name, instance, port, state, phone, created_unix, updated_unix
		 FROM tenants ORDER BY display_name, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Tenant
	for rows.Next() {
		var t Tenant
		var created, updated int64
		var state string
		if err := rows.Scan(&t.ID, &t.DisplayName, &t.Instance, &t.Port, &state,
			&t.Phone, &created, &updated); err != nil {
			return nil, err
		}
		t.State = State(state)
		t.CreatedAt, t.UpdatedAt = time.Unix(created, 0), time.Unix(updated, 0)
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) SetTenantState(id string, st State, phone string) error {
	res, err := s.db.Exec(
		`UPDATE tenants SET state = ?, phone = CASE WHEN ? != '' THEN ? ELSE phone END,
		 updated_unix = ? WHERE id = ?`,
		string(st), phone, phone, time.Now().Unix(), id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("store: no tenant %q", id)
	}
	return nil
}

func (s *Store) DeleteTenant(id string) error {
	_, err := s.db.Exec(`DELETE FROM tenants WHERE id = ?`, id)
	return err
}

func (s *Store) AppendEvent(tenantID, kind, detail string) error {
	_, err := s.db.Exec(
		`INSERT INTO events (tenant_id, kind, detail, at_unix) VALUES (?, ?, ?, ?)`,
		tenantID, kind, detail, time.Now().Unix())
	return err
}

// ListEvents returns the most recent events first — an operator opening a dead
// number wants the cause at the top, not the provisioning record.
func (s *Store) ListEvents(tenantID string, limit int) ([]Event, error) {
	rows, err := s.db.Query(
		`SELECT kind, detail, at_unix FROM events WHERE tenant_id = ?
		 ORDER BY id DESC LIMIT ?`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Event
	for rows.Next() {
		var e Event
		var at int64
		if err := rows.Scan(&e.Kind, &e.Detail, &at); err != nil {
			return nil, err
		}
		e.At = time.Unix(at, 0)
		out = append(out, e)
	}
	return out, rows.Err()
}
