package health

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

func openStore(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "mgr.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestReconcileMarksRunningWhenReachableAndConnected(t *testing.T) {
	s := openStore(t)
	tenant := store.Tenant{ID: "t1", Instance: "t1", Port: 1, State: store.StatePairing}
	if err := s.CreateTenant(tenant); err != nil {
		t.Fatalf("CreateTenant: %v", err)
	}

	reports := map[string]Report{"t1": {Reachable: true, Connected: true}}
	if err := Reconcile(s, []store.Tenant{tenant}, reports); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	got, err := s.GetTenant("t1")
	if err != nil {
		t.Fatalf("GetTenant: %v", err)
	}
	if got.State != store.StateRunning {
		t.Fatalf("state = %q, want running", got.State)
	}
}

func TestReconcileMarksLoggedOutAndRecordsOneEvent(t *testing.T) {
	s := openStore(t)
	tenant := store.Tenant{ID: "t1", Instance: "t1", Port: 1, State: store.StateRunning}
	if err := s.CreateTenant(tenant); err != nil {
		t.Fatalf("CreateTenant: %v", err)
	}

	reports := map[string]Report{"t1": {Reachable: true, Killed: true, Connected: false}}

	// First poll: killed + disconnected while stored state is still "running"
	// must transition to logged_out AND append exactly one event.
	if err := Reconcile(s, []store.Tenant{tenant}, reports); err != nil {
		t.Fatalf("Reconcile (1st): %v", err)
	}
	got, err := s.GetTenant("t1")
	if err != nil {
		t.Fatalf("GetTenant: %v", err)
	}
	if got.State != store.StateLoggedOut {
		t.Fatalf("state = %q, want logged_out", got.State)
	}
	events, err := s.ListEvents("t1", 10)
	if err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1: %+v", len(events), events)
	}

	// Second identical poll, now against the already-logged_out tenant row:
	// must NOT append a second event.
	if err := Reconcile(s, []store.Tenant{got}, reports); err != nil {
		t.Fatalf("Reconcile (2nd): %v", err)
	}
	events, err = s.ListEvents("t1", 10)
	if err != nil {
		t.Fatalf("ListEvents (2nd): %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("events after 2nd poll = %d, want still 1 (no duplicate)", len(events))
	}
}

func TestReconcileLeavesStateAloneWhenUnreachable(t *testing.T) {
	s := openStore(t)
	tenant := store.Tenant{ID: "t1", Instance: "t1", Port: 1, State: store.StateRunning}
	if err := s.CreateTenant(tenant); err != nil {
		t.Fatalf("CreateTenant: %v", err)
	}

	// Killed:true is deliberate: this report would otherwise satisfy neither
	// switch case in Reconcile, so dropping the !Reachable guard would be
	// invisible to this test. With Killed:true, an unguarded Reconcile would
	// hit the logged_out branch — pinning the guard, not just exercising it.
	reports := map[string]Report{"t1": {Reachable: false, Killed: true, Err: "unreachable: request failed"}}
	if err := Reconcile(s, []store.Tenant{tenant}, reports); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	got, err := s.GetTenant("t1")
	if err != nil {
		t.Fatalf("GetTenant: %v", err)
	}
	if got.State != store.StateRunning {
		t.Fatalf("state = %q, want unchanged running (manager restart / blip must not log out a live tenant)", got.State)
	}
	events, err := s.ListEvents("t1", 10)
	if err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("events = %d, want 0", len(events))
	}
}

// A tenant destroyed between the ListTenants that built the sweep and the
// write that reconciles it takes every write with it: its row is gone, so
// SetTenantState reports "no tenant". Returning on that first error abandoned
// every tenant AFTER it in the list — one deleted number silently stopped
// reconciling all the others, including the logged_out event that dates a ban.
//
// The failure must still be reported, and the rest of the sweep must still
// happen.
func TestReconcileContinuesPastOneTenantsFailure(t *testing.T) {
	s := openStore(t)
	tenants := []store.Tenant{
		{ID: "before", Instance: "before", Port: 1, State: store.StatePairing},
		{ID: "gone", Instance: "gone", Port: 2, State: store.StateRunning},
		{ID: "after", Instance: "after", Port: 3, State: store.StateRunning},
	}
	for _, tenant := range tenants {
		if err := s.CreateTenant(tenant); err != nil {
			t.Fatalf("CreateTenant %q: %v", tenant.ID, err)
		}
	}
	// Destroyed after the sweep listed it, exactly as a concurrent teardown
	// does. The sweep still holds the stale row.
	if err := s.DeleteTenant("gone"); err != nil {
		t.Fatalf("DeleteTenant: %v", err)
	}

	reports := map[string]Report{
		"before": {Reachable: true, Connected: true},
		"gone":   {Reachable: true, Killed: true, Connected: false},
		"after":  {Reachable: true, Killed: true, Connected: false},
	}
	err := Reconcile(s, tenants, reports)
	if err == nil {
		t.Fatal("a tenant whose row vanished mid-sweep must still be reported, not swallowed")
	}
	if !strings.Contains(err.Error(), "gone") {
		t.Fatalf("the error must name the tenant that failed; got %v", err)
	}

	// The tenant BEFORE the failure was reconciled, and — the point of this
	// test — so was the one after it.
	got, gotErr := s.GetTenant("before")
	if gotErr != nil {
		t.Fatalf("GetTenant before: %v", gotErr)
	}
	if got.State != store.StateRunning {
		t.Fatalf("tenant before the failure: state = %q, want running", got.State)
	}
	got, gotErr = s.GetTenant("after")
	if gotErr != nil {
		t.Fatalf("GetTenant after: %v", gotErr)
	}
	if got.State != store.StateLoggedOut {
		t.Fatalf("tenant after the failure was abandoned: state = %q, want logged_out", got.State)
	}
	events, gotErr := s.ListEvents("after", 10)
	if gotErr != nil {
		t.Fatalf("ListEvents: %v", gotErr)
	}
	if len(events) != 1 {
		t.Fatalf("the logged_out event after the failure = %d, want 1", len(events))
	}
}

// The Connected branch wrote on EVERY sweep. A healthy tenant is connected
// every time, so under synchronous=FULL that is one fsync-backed UPDATE per
// tenant per cycle — ~13 writes a second at 200 tenants — recording state that
// is not changing. Only a CHANGE may write, exactly as the logged_out branch
// already did.
//
// The write is observed through updated_unix, which SetTenantState stamps with
// the current time. The row is seeded far enough in the past that a write is
// unmistakable rather than a second-boundary coin flip.
func TestReconcileDoesNotRewriteAnAlreadyRunningTenant(t *testing.T) {
	s := openStore(t)
	long := time.Now().Add(-100 * 24 * time.Hour).Truncate(time.Second)
	running := store.Tenant{ID: "steady", Instance: "steady", Port: 1,
		State: store.StateRunning, CreatedAt: long}
	pairing := store.Tenant{ID: "fresh", Instance: "fresh", Port: 2,
		State: store.StatePairing, CreatedAt: long}
	for _, tenant := range []store.Tenant{running, pairing} {
		if err := s.CreateTenant(tenant); err != nil {
			t.Fatalf("CreateTenant %q: %v", tenant.ID, err)
		}
	}

	reports := map[string]Report{
		"steady": {Reachable: true, Connected: true},
		"fresh":  {Reachable: true, Connected: true},
	}
	if err := Reconcile(s, []store.Tenant{running, pairing}, reports); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	got, err := s.GetTenant("steady")
	if err != nil {
		t.Fatalf("GetTenant steady: %v", err)
	}
	if !got.UpdatedAt.Equal(long) {
		t.Fatalf("an already-running tenant was rewritten (updated_unix %v -> %v); "+
			"only a state CHANGE may write", long, got.UpdatedAt)
	}

	// The other half: a tenant whose state IS changing must still be written,
	// so the guard cannot be satisfied by never writing at all.
	got, err = s.GetTenant("fresh")
	if err != nil {
		t.Fatalf("GetTenant fresh: %v", err)
	}
	if got.State != store.StateRunning {
		t.Fatalf("a tenant that became connected was not written: state = %q", got.State)
	}
	if got.UpdatedAt.Equal(long) {
		t.Fatal("a real transition left updated_unix untouched")
	}
}
