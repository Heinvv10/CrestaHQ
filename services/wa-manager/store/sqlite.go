// Package store persists the manager's own state: which tenants exist, which
// port each was allocated, and an append-only log of what happened to them.
//
// It holds NO message content. The manager is a supervisor and a view; it has
// even less reason than the bridge to see a message body, and the same POPIA
// constraint applies.
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"sync"
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

type Store struct {
	db *sql.DB
	// rolloutMu serialises RequestRollout's read-then-write. See the comment
	// there: a deferred SQLite transaction fails a lock upgrade outright
	// rather than waiting.
	rolloutMu sync.Mutex
}

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

-- One row per requested rollout. A rollout is a standing intent — "every
-- bridge should be running version X" — not a list of steps, so there is
-- nothing here enumerating tenants: the worker asks each bridge what it is
-- running and restarts the ones that disagree. That makes a rollout
-- idempotent, resumable across a manager restart, and self-correcting for a
-- bridge that was down while it ran.
--
-- At most one row is ever pending or running; see ClaimRollout.
CREATE TABLE IF NOT EXISTS rollouts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  version       TEXT NOT NULL,          -- the build every bridge should reach
  state         TEXT NOT NULL,          -- pending | running | done | failed
  immediate     INTEGER NOT NULL,       -- 1 = --now, ignore the window
  detail        TEXT NOT NULL DEFAULT '',
  requested_unix INTEGER NOT NULL,
  finished_unix  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rollouts_state ON rollouts(state, id);
-- At most ONE outstanding rollout, enforced here rather than by the
-- read-then-write in RequestRollout. Two deploys racing could each see no
-- outstanding row and insert one, and two rollouts on different targets would
-- take turns bouncing the same customer numbers back and forth. A partial
-- unique index makes that impossible rather than unlikely.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rollouts_one_outstanding
  ON rollouts((1)) WHERE state IN ('pending','running');
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

// DeleteTenant removes the tenant and its event history together. A dead
// tenant's history is not worth keeping — the opaque id can be re-provisioned
// for a different customer later, and that customer must not inherit the
// previous incarnation's events (design §3.2: teardown leaves nothing behind).
func (s *Store) DeleteTenant(id string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM events WHERE tenant_id = ?`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM tenants WHERE id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
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

// SetTenantIdentity records the display name and the systemd instance name for
// a tenant that AllocatePort has already created.
//
// AllocatePort has to insert the row to make the allocation atomic, and at that
// moment it knows only the opaque id — so it seeds `instance` with the id and
// leaves the display name empty. The provisioner is the component that derives
// the real, systemd-safe instance name, so it writes it here.
//
// The UNIQUE constraint on `instance` is doing real work: two different tenant
// ids can sanitise to the same instance name, and two tenants sharing one
// instance would share one WhatsApp session. The loser of that race fails here
// rather than silently taking over its neighbour's directory.
func (s *Store) SetTenantIdentity(id, displayName, instance string) error {
	res, err := s.db.Exec(
		`UPDATE tenants SET display_name = ?, instance = ?, updated_unix = ? WHERE id = ?`,
		displayName, instance, time.Now().Unix(), id)
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

// Rollout states. A rollout is pending until the worker picks it up, running
// while it is bouncing bridges, and then terminal — done or failed.
const (
	RolloutPending = "pending"
	RolloutRunning = "running"
	RolloutDone    = "done"
	RolloutFailed  = "failed"
)

// Rollout is one requested fleet upgrade.
type Rollout struct {
	ID        int64
	Version   string
	State     string
	Immediate bool
	Detail    string
	Requested time.Time
	Finished  time.Time
}

// RequestRollout records the intent to bring every bridge to version.
//
// An outstanding rollout is SUPERSEDED rather than refused. There is only ever
// one valid target — the binary currently installed on disk, which every
// instance shares — so a newer request is not a competing intent, it is a
// correction of the previous one.
//
// Refusing was worse than useless. Deploy at 18:00 queues a rollout to v1 for
// the 22:00 window; fix a bug and deploy again at 19:00; the second deploy has
// ALREADY installed the v2 binary and restarted the manager by the time it
// asks for a rollout, so a refusal left the fleet aimed at a v1 that no longer
// exists on disk. At 22:00 the worker would restart a number, watch it come
// back as v2, refuse to accept it, and hold — having spent a real customer's
// five minutes to achieve nothing, with v2 never rolling at all. Deploying
// twice in an evening is the normal case, not a corner.
//
// Superseding also removes the only way this table could wedge a deployment:
// a rollout left `running` by a manager that was killed mid-tick used to block
// every future request until someone edited the database by hand.
func (s *Store) RequestRollout(version string, immediate bool) (Rollout, error) {
	// Serialised in-process. This reads a row and then writes it, and a
	// deferred SQLite transaction refuses that lock UPGRADE immediately with
	// SQLITE_BUSY rather than waiting out _busy_timeout — so two deploys
	// landing together would fail one of them for a reason no human could act
	// on. One mutex is the readable fix; the partial unique index on the table
	// is what still holds if a second process ever exists.
	s.rolloutMu.Lock()
	defer s.rolloutMu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return Rollout{}, err
	}
	defer tx.Rollback()

	var existing Rollout
	var req, fin int64
	var imm int
	err = tx.QueryRow(
		`SELECT id, version, state, immediate, detail, requested_unix, finished_unix
		   FROM rollouts WHERE state IN (?, ?) ORDER BY id LIMIT 1`,
		RolloutPending, RolloutRunning).
		Scan(&existing.ID, &existing.Version, &existing.State, &imm, &existing.Detail, &req, &fin)
	switch {
	case err == nil:
		// Urgency belongs to the BUILD it was requested for. A later `--now`
		// escalates a rollout already queued for tonight — that is the whole
		// point of the flag when a fix cannot wait — but a request that
		// changes the target carries its own urgency and does not inherit the
		// previous one. Making it sticky across a retarget meant an operator's
		// `--now` on v1, followed by a routine unhurried deploy of v2, left
		// the row marked immediate: at ten on Monday morning the worker
		// skipped the window and restarted a customer's number for a rollout
		// nobody had marked urgent.
		if existing.Version != version {
			imm = 0
		}
		if immediate {
			imm = 1
		}
		// A repeat request for the SAME build does not restart the state
		// machine. The deploy script may legitimately ask twice, and resetting
		// a rollout that is mid-flight back to pending throws away the
		// progress detail the operator screen is currently showing. Only the
		// target actually changing is a supersede.
		state := existing.State
		detail := existing.Detail
		if existing.Version != version {
			state, detail = RolloutPending, ""
		}
		if _, err := tx.Exec(
			`UPDATE rollouts SET version = ?, state = ?, immediate = ?, detail = ?, requested_unix = ?
			   WHERE id = ?`,
			version, state, imm, detail, time.Now().Unix(), existing.ID); err != nil {
			return Rollout{}, err
		}
		return Rollout{
			ID: existing.ID, Version: version, State: state, Detail: detail,
			Immediate: imm == 1, Requested: time.Now(),
		}, tx.Commit()
	case !errors.Is(err, sql.ErrNoRows):
		return Rollout{}, err
	}

	now := time.Now()
	immInt := 0
	if immediate {
		immInt = 1
	}
	res, err := tx.Exec(
		`INSERT INTO rollouts (version, state, immediate, requested_unix) VALUES (?, ?, ?, ?)`,
		version, RolloutPending, immInt, now.Unix())
	if err != nil {
		return Rollout{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Rollout{}, err
	}
	if err := tx.Commit(); err != nil {
		return Rollout{}, err
	}
	return Rollout{ID: id, Version: version, State: RolloutPending, Immediate: immediate, Requested: now}, nil
}

// CurrentRollout returns the outstanding rollout, or ok=false when there is
// none. Only pending and running rollouts are outstanding; a finished one is
// history and is read with LastRollout.
func (s *Store) CurrentRollout() (Rollout, bool, error) {
	return s.rolloutWhere(`state IN ('pending','running') ORDER BY id LIMIT 1`)
}

// LastRollout returns the most recent rollout in any state.
func (s *Store) LastRollout() (Rollout, bool, error) {
	return s.rolloutWhere(`1=1 ORDER BY id DESC LIMIT 1`)
}

func (s *Store) rolloutWhere(clause string) (Rollout, bool, error) {
	var r Rollout
	var req, fin int64
	var imm int
	err := s.db.QueryRow(
		`SELECT id, version, state, immediate, detail, requested_unix, finished_unix
		   FROM rollouts WHERE `+clause).
		Scan(&r.ID, &r.Version, &r.State, &imm, &r.Detail, &req, &fin)
	if errors.Is(err, sql.ErrNoRows) {
		return Rollout{}, false, nil
	}
	if err != nil {
		return Rollout{}, false, err
	}
	r.Immediate = imm == 1
	r.Requested = time.Unix(req, 0)
	if fin != 0 {
		r.Finished = time.Unix(fin, 0)
	}
	return r, true, nil
}

// SetRolloutState moves a rollout on, stamping finished_unix for a terminal
// state. detail is what the operator screen shows — for a failure, which
// instance stopped it.
//
// It is a COMPARE-AND-SET on the version, and ok=false means the rollout was
// superseded while the caller was working. That is not an error and the caller
// must not treat it as one — but writing without the check was a lost update
// with a false success at the end of it. The worker reads the rollout, spends
// up to ninety seconds settling one bridge, then writes the outcome; a deploy
// landing in that window supersedes the row in place, and a bare `WHERE id`
// stamped the OLD rollout's verdict onto the NEW target. The observed result
// was a row reading done/v2 while the only bridge was still running v1, and a
// deploy script that read that and printed "every bridge rolled".
func (s *Store) SetRolloutState(id int64, expectVersion, state, detail string) (bool, error) {
	finished := int64(0)
	if state == RolloutDone || state == RolloutFailed {
		finished = time.Now().Unix()
	}
	res, err := s.db.Exec(
		`UPDATE rollouts SET state = ?, detail = ?, finished_unix = ?
		   WHERE id = ? AND version = ?`,
		state, detail, finished, id, expectVersion)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}
