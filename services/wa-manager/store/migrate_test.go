package store

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

// oldSchema is `tenants` exactly as it was before last_dropped_inbound existed.
// It is written out verbatim rather than derived from the current schema const:
// the whole point is a database that predates the column, and one that follows
// the const would silently stop testing anything the day the const changes.
const oldSchema = `
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
`

func hasColumn(t *testing.T, path, table, column string) bool {
	t.Helper()
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer db.Close()
	rows, err := db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		t.Fatalf("PRAGMA table_info: %v", err)
	}
	defer rows.Close()
	found := false
	for rows.Next() {
		var cid, notnull, pk int
		var name, ctype string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			t.Fatalf("Scan: %v", err)
		}
		if name == column {
			found = true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err: %v", err)
	}
	return found
}

// There is a live database on disk with a real tenant in it, and
// CREATE TABLE IF NOT EXISTS is a no-op against it — so without the guarded
// ALTER, every read of the new column on the deployed manager fails outright.
func TestOpenAddsTheDroppedInboundColumnToAnOlderDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")

	raw, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	if _, err := raw.Exec(oldSchema); err != nil {
		t.Fatalf("old schema: %v", err)
	}
	if _, err := raw.Exec(
		`INSERT INTO tenants (id, display_name, instance, port, state, phone, created_unix, updated_unix)
		 VALUES ('live', 'Blitz Fibre', 'blitz', 33101, 'running', '27821234567', 1000, 2000)`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	raw.Close()

	if hasColumn(t, path, "tenants", "last_dropped_inbound") {
		t.Fatal("fixture is not an old database — it already has the column")
	}

	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open on an older database: %v", err)
	}
	defer s.Close()

	if !hasColumn(t, path, "tenants", "last_dropped_inbound") {
		t.Fatal("Open did not add last_dropped_inbound to an existing tenants table")
	}

	// The pre-existing row must survive intact, defaulting to a zero baseline.
	got, err := s.GetTenant("live")
	if err != nil {
		t.Fatalf("GetTenant after upgrade: %v", err)
	}
	if got.DisplayName != "Blitz Fibre" || got.Instance != "blitz" ||
		got.Port != 33101 || got.State != StateRunning || got.Phone != "27821234567" {
		t.Fatalf("the existing row did not survive the upgrade: %+v", got)
	}
	if got.LastDroppedInbound != 0 {
		t.Fatalf("baseline = %d, want 0 for a row that predates the column", got.LastDroppedInbound)
	}
	if !got.CreatedAt.Equal(time.Unix(1000, 0)) {
		t.Fatalf("created_unix = %v, want it untouched", got.CreatedAt)
	}
}

// SQLite has no ADD COLUMN IF NOT EXISTS: a second ALTER errors. Opening an
// already-upgraded database is the normal case (every manager restart), so it
// must be a silent no-op — and the check must be the PRAGMA, not a swallowed
// error that would also hide a real ALTER failure.
func TestOpenOnAnAlreadyUpgradedDatabaseIsANoOp(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mgr.db")

	first, err := Open(path)
	if err != nil {
		t.Fatalf("Open (1st): %v", err)
	}
	if err := first.CreateTenant(Tenant{
		ID: "t1", Instance: "t1", Port: 33101, State: StateRunning,
		LastDroppedInbound: 4,
	}); err != nil {
		t.Fatalf("CreateTenant: %v", err)
	}
	first.Close()

	second, err := Open(path)
	if err != nil {
		t.Fatalf("Open (2nd) on an already-upgraded database: %v", err)
	}
	defer second.Close()

	got, err := second.GetTenant("t1")
	if err != nil {
		t.Fatalf("GetTenant: %v", err)
	}
	if got.LastDroppedInbound != 4 {
		t.Fatalf("baseline = %d, want 4", got.LastDroppedInbound)
	}
}

// The baseline is a COLUMN and not a map in the poller for exactly this
// reason: an in-memory baseline restarts at zero with the manager, and the
// next sweep then re-fires an event for drops already recorded.
func TestDroppedInboundBaselineSurvivesAReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mgr.db")

	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := s.CreateTenant(Tenant{ID: "t1", Instance: "t1", Port: 33101, State: StateRunning}); err != nil {
		t.Fatalf("CreateTenant: %v", err)
	}
	if err := s.SetLastDroppedInbound("t1", 7); err != nil {
		t.Fatalf("SetLastDroppedInbound: %v", err)
	}
	s.Close()

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("Open (reopen): %v", err)
	}
	defer reopened.Close()

	got, err := reopened.GetTenant("t1")
	if err != nil {
		t.Fatalf("GetTenant: %v", err)
	}
	if got.LastDroppedInbound != 7 {
		t.Fatalf("baseline after reopen = %d, want 7", got.LastDroppedInbound)
	}

	all, err := reopened.ListTenants()
	if err != nil {
		t.Fatalf("ListTenants: %v", err)
	}
	if len(all) != 1 || all[0].LastDroppedInbound != 7 {
		t.Fatalf("ListTenants must carry the baseline too; got %+v", all)
	}
}

func TestSetLastDroppedInboundRejectsAnUnknownTenant(t *testing.T) {
	s := openTemp(t)
	if err := s.SetLastDroppedInbound("nope", 1); err == nil {
		t.Fatal("writing a baseline for a tenant that does not exist must fail")
	}
}

// The losing side of the race, reproduced deterministically.
//
// The presence check in addLastDroppedInboundColumn is check-then-act: another
// process can add the column between the PRAGMA and the ALTER, and SQLite
// answers the loser with "duplicate column name". Propagating that would refuse
// to start over a database that is, in fact, correct — burning a systemd
// StartLimitBurst attempt and printing an alarming line on the one deploy where
// the database is still un-migrated.
//
// Calling addDroppedInboundColumn twice IS the loser's path: the second ALTER
// fails exactly as the loser's does. Driving it this way rather than with
// goroutines is deliberate — the real race is rare (measured: 3 duplicate-column
// errors in 1200 concurrent opens), so a concurrent test would be green under a
// broken implementation ~99.8% of the time, which is worse than no test.
//
// MENTIONED, NOT FIXED: a concurrent Open can also fail with "database is
// locked" (29 of those same 1200). That is not this change — the same hammer
// against origin/main, whose Open runs only CREATE TABLE / CREATE INDEX, fails
// that way too. DDL takes an exclusive lock and _busy_timeout does not rescue
// every shape of it. In production one systemd instance owns this file.
func TestAddingTheColumnTwiceIsNotAnError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mgr.db")
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(oldSchema); err != nil {
		t.Fatalf("seed old schema: %v", err)
	}

	if err := addDroppedInboundColumn(db); err != nil {
		t.Fatalf("first add: %v", err)
	}
	if err := addDroppedInboundColumn(db); err != nil {
		t.Fatalf("the loser of the race must start, not die on a column another "+
			"opener had just added: %v", err)
	}
	if !hasColumn(t, path, "tenants", "last_dropped_inbound") {
		t.Fatal("the column is missing after two adds")
	}
}

// A genuine ALTER failure must still be returned — the re-check tolerates the
// duplicate ONLY when the column really is there afterwards.
func TestAGenuineAlterFailureIsStillReturned(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mgr.db")
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer db.Close()
	// No `tenants` table at all, so the ALTER fails for a reason that is not a
	// race and that the re-check must not absorb.
	if err := addDroppedInboundColumn(db); err == nil {
		t.Fatal("an ALTER against a missing table must be reported, not swallowed")
	}
}
