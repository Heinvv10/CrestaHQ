package store

import (
	"database/sql"
	"fmt"
)

// AllocatePort assigns the lowest free port in [base, base+count) to tenantID
// and returns it. Re-allocating for a tenant that already holds one returns the
// same port rather than moving it — provisioning is retried after partial
// failures, and a retry that moved the port would orphan a running unit.
//
// Atomicity comes from the UNIQUE constraint on tenants.port, not from a lock:
// each candidate is an INSERT that either wins or violates the constraint, so
// two concurrent provisioners cannot both take one port however they interleave.
func (s *Store) AllocatePort(tenantID string, base, count int) (int, error) {
	var existing int
	err := s.db.QueryRow(`SELECT port FROM tenants WHERE id = ?`, tenantID).Scan(&existing)
	if err == nil {
		return existing, nil
	}
	if err != sql.ErrNoRows {
		return 0, err
	}

	for p := base; p < base+count; p++ {
		res, err := s.db.Exec(
			`INSERT OR IGNORE INTO tenants (id, instance, port, state, created_unix, updated_unix)
			 VALUES (?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))`,
			tenantID, tenantID, p, string(StateProvisioned))
		if err != nil {
			return 0, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return 0, err
		}
		if n == 1 {
			return p, nil
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
		return existing, nil
	}
	if err != sql.ErrNoRows {
		return 0, err
	}
	return 0, fmt.Errorf("store: no free port in [%d,%d)", base, base+count)
}

// ReleasePort frees a tenant's port by removing its row. Teardown must call
// this LAST, after the unit is stopped and its files are gone: a freed port
// that a live process still holds would be handed to the next tenant, whose
// bridge would then fail to bind.
func (s *Store) ReleasePort(tenantID string) error {
	return s.DeleteTenant(tenantID)
}
