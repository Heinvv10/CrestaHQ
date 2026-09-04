package health

import (
	"path/filepath"
	"testing"

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

	reports := map[string]Report{"t1": {Reachable: false, Err: "unreachable: request failed"}}
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
