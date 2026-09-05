package store

import (
	"database/sql"
	"fmt"
)

// AllocatePort assigns the lowest free port in [base, base+count) to tenantID
// and returns it, along with whether this call is the one that CREATED the
// tenant's row.
//
// Re-allocating for a tenant that already holds one returns the same port
// rather than moving it — provisioning is retried after partial failures, and a
// retry that moved the port would orphan a running unit. The `inserted` result
// is how a caller tells those two cases apart, and it is a return value rather
// than something a caller must remember to look up because getting it wrong is
// destructive: a Create that treats a row it did not insert as its own goes on
// to rewrite a live bridge's tokens and, if it later fails, unwinds the OTHER
// caller's instance. Two concurrent Creates for one id did exactly that.
//
// Atomicity comes from the UNIQUE constraint on tenants.port, not from a lock:
// each candidate is an INSERT that either wins or violates the constraint, so
// two concurrent provisioners cannot both take one port however they interleave.
// The same INSERT is the mutual exclusion for one tenant id, because id is the
// PRIMARY KEY: exactly one concurrent caller can see inserted=true.
func (s *Store) AllocatePort(tenantID string, base, count int) (int, bool, error) {
	var existing int
	err := s.db.QueryRow(`SELECT port FROM tenants WHERE id = ?`, tenantID).Scan(&existing)
	if err == nil {
		return existing, false, nil
	}
	if err != sql.ErrNoRows {
		return 0, false, err
	}

	for p := base; p < base+count; p++ {
		res, err := s.db.Exec(
			`INSERT OR IGNORE INTO tenants (id, instance, port, state, created_unix, updated_unix)
			 VALUES (?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))`,
			tenantID, tenantID, p, string(StateProvisioned))
		if err != nil {
			return 0, false, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return 0, false, err
		}
		if n == 1 {
			return p, true, nil
		}
	}

	// Every candidate in the range was ignored. That's ambiguous: either the
	// range is genuinely full, or a concurrent caller for THIS SAME tenant id
	// won its own row somewhere in the range after our idempotency check above
	// missed it (a double-clicked provision, or a retry racing a slow first
	// attempt). Re-check before reporting exhaustion — only a genuinely full
	// range should produce that error; a same-tenant race must return the
	// winner's port instead of a lying "no free port".
	err = s.db.QueryRow(`SELECT port FROM tenants WHERE id = ?`, tenantID).Scan(&existing)
	if err == nil {
		return existing, false, nil
	}
	if err != sql.ErrNoRows {
		return 0, false, err
	}
	return 0, false, fmt.Errorf("store: no free port in [%d,%d)", base, base+count)
}

// ReleasePort frees a tenant's port by removing its row. Teardown must call
// this LAST, after the unit is stopped and its files are gone: a freed port
// that a live process still holds would be handed to the next tenant, whose
// bridge would then fail to bind.
func (s *Store) ReleasePort(tenantID string) error {
	return s.DeleteTenant(tenantID)
}
