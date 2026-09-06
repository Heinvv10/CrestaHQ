package store

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func openTemp(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "mgr.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestTenantRoundTripSurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mgr.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CreateTenant(Tenant{
		ID: "t1", DisplayName: "Blitz Fibre", Instance: "blitz", Port: 33101,
		State: StateProvisioned, CreatedAt: time.Unix(1000, 0),
	}); err != nil {
		t.Fatal(err)
	}
	s.Close()

	s2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()

	got, err := s2.GetTenant("t1")
	if err != nil {
		t.Fatal(err)
	}
	if got.DisplayName != "Blitz Fibre" || got.Port != 33101 || got.State != StateProvisioned {
		t.Fatalf("tenant did not survive reopen: %+v", got)
	}
}

func TestTenantIDIsUnique(t *testing.T) {
	s := openTemp(t)
	base := Tenant{ID: "t1", Instance: "a", Port: 1, State: StateProvisioned}
	if err := s.CreateTenant(base); err != nil {
		t.Fatal(err)
	}
	dup := base
	dup.Instance, dup.Port = "b", 2
	if err := s.CreateTenant(dup); err == nil {
		t.Fatal("a duplicate tenant id must be refused, not silently overwrite")
	}
}

func TestEventsAreAppendOnlyAndOrdered(t *testing.T) {
	s := openTemp(t)
	s.CreateTenant(Tenant{ID: "t1", Instance: "a", Port: 1, State: StateProvisioned})

	s.AppendEvent("t1", "provisioned", "port 1")
	s.AppendEvent("t1", "paired", "")
	s.AppendEvent("t1", "logged_out", "banned or unlinked")

	evts, err := s.ListEvents("t1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(evts) != 3 {
		t.Fatalf("want 3 events, got %d", len(evts))
	}
	// Newest first: an operator opening a dead number wants the cause at the top.
	if evts[0].Kind != "logged_out" {
		t.Fatalf("want newest first, got %q", evts[0].Kind)
	}
}

// Teardown must leave nothing of the tenant behind (design §3.2). Without this,
// re-provisioning the same opaque id later would interleave the previous
// incarnation's events into ListEvents — ghosts from a cancelled customer
// showing up for whoever inherits the id next.
func TestDeleteTenantRemovesEvents(t *testing.T) {
	s := openTemp(t)
	s.CreateTenant(Tenant{ID: "t1", Instance: "a", Port: 1, State: StateProvisioned})
	s.AppendEvent("t1", "provisioned", "port 1")
	s.AppendEvent("t1", "logged_out", "banned or unlinked")

	if err := s.DeleteTenant("t1"); err != nil {
		t.Fatal(err)
	}

	evts, err := s.ListEvents("t1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(evts) != 0 {
		t.Fatalf("want events gone with the tenant, got %d: %+v", len(evts), evts)
	}
}

// Two different tenant ids can sanitise to one instance name, and the loser of
// that race discovers it here. It must come back as ErrInstanceTaken: the
// caller turns that into an authored 409 naming the duplicate, where a raw
// driver error becomes a 500 blaming the manager's disk.
func TestSetTenantIdentityReportsAContestedInstance(t *testing.T) {
	s := openTemp(t)
	for _, id := range []string{"a.b", "a-b"} {
		if _, _, err := s.AllocatePort(id, 33100, 10); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.SetTenantIdentity("a.b", "Winner", "a-b"); err != nil {
		t.Fatalf("the winner must take the name: %v", err)
	}
	err := s.SetTenantIdentity("a-b", "Loser", "a-b")
	if !errors.Is(err, ErrInstanceTaken) {
		t.Fatalf("a contested instance must be ErrInstanceTaken, got %v", err)
	}
	if !strings.Contains(err.Error(), "a-b") {
		t.Fatalf("the error must name the contested instance: %v", err)
	}
	// The loser's row keeps its seed — nothing partial was written.
	loser, err := s.GetTenant("a-b")
	if err != nil {
		t.Fatal(err)
	}
	if loser.Instance != PendingInstance("a-b") {
		t.Fatalf("a refused identity write still changed the row: instance=%q", loser.Instance)
	}
	// And the winner is untouched.
	winner, err := s.GetTenant("a.b")
	if err != nil {
		t.Fatal(err)
	}
	if winner.Instance != "a-b" || winner.DisplayName != "Winner" {
		t.Fatalf("the loser's failure disturbed the winner: %+v", winner)
	}
}

// An id that does not exist is a different failure and must not be reported as
// a contested instance — one is a caller bug, the other a duplicate tenant.
func TestSetTenantIdentityUnknownTenantIsNotAContestedInstance(t *testing.T) {
	s := openTemp(t)
	err := s.SetTenantIdentity("ghost", "Ghost", "ghost")
	if err == nil {
		t.Fatal("writing an identity for a tenant that does not exist must fail")
	}
	if errors.Is(err, ErrInstanceTaken) {
		t.Fatalf("a missing tenant is not a contested instance: %v", err)
	}
	if !strings.Contains(err.Error(), `no tenant "ghost"`) {
		t.Fatalf("want the existing no-tenant error, got %v", err)
	}
}
