package store

import (
	"strings"
	"sync"
	"testing"
)

func TestAllocatePortIsUniquePerTenant(t *testing.T) {
	s := openTemp(t)
	a, _, err := s.AllocatePort("t1", 33100, 10)
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := s.AllocatePort("t2", 33100, 10)
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatalf("two tenants got the same port: %d", a)
	}
}

func TestAllocatePortIsIdempotentForOneTenant(t *testing.T) {
	s := openTemp(t)
	a, insertedFirst, _ := s.AllocatePort("t1", 33100, 10)
	b, insertedAgain, err := s.AllocatePort("t1", 33100, 10)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatalf("re-allocating for one tenant moved its port %d -> %d", a, b)
	}
	// Which call CREATED the row is what the provisioner uses to refuse a
	// duplicate Create without tearing down the caller that owns the tenant.
	// Reported wrong, the second Create rewrites a live bridge's tokens.
	if !insertedFirst {
		t.Fatal("the first allocation created the row and must report inserted")
	}
	if insertedAgain {
		t.Fatal("re-allocating for a tenant that already has a row must NOT report inserted")
	}
}

func TestAllocatePortExhaustionIsAnError(t *testing.T) {
	s := openTemp(t)
	for i := 0; i < 3; i++ {
		if _, _, err := s.AllocatePort(string(rune('a'+i)), 33100, 3); err != nil {
			t.Fatalf("allocation %d failed early: %v", i, err)
		}
	}
	if _, _, err := s.AllocatePort("overflow", 33100, 3); err == nil {
		t.Fatal("exhausting the range must be a loud error, not a silent reuse")
	}
}

// Concurrent provisioning must never hand two tenants the same port. A single
// round of goroutines does not reliably contend — three phase-1 tests passed
// under the exact bugs they targeted for that reason — so this uses a ready
// barrier and many rounds, and is worth running at GOMAXPROCS=1 too.
func TestAllocatePortIsAtomicUnderConcurrency(t *testing.T) {
	const rounds, workers = 30, 16
	for r := 0; r < rounds; r++ {
		s := openTemp(t)
		var ready, done sync.WaitGroup
		start := make(chan struct{})
		ready.Add(workers)
		done.Add(workers)

		got := make([]int, workers)
		errs := make([]error, workers)
		for i := 0; i < workers; i++ {
			go func(i int) {
				defer done.Done()
				ready.Done()
				<-start
				got[i], _, errs[i] = s.AllocatePort(string(rune('a'+i)), 33100, workers)
			}(i)
		}
		ready.Wait()
		close(start)
		done.Wait()

		seen := map[int]int{}
		for i, p := range got {
			if errs[i] != nil {
				t.Fatalf("round %d worker %d: %v", r, i, errs[i])
			}
			if prev, dup := seen[p]; dup {
				t.Fatalf("round %d: port %d given to workers %d and %d", r, p, prev, i)
			}
			seen[p] = i
		}
	}
}

// A double-clicked provision or a retry racing a slow first attempt both miss
// the idempotency SELECT before any winner exists. Every AllocatePort call for
// the SAME tenant id, run concurrently, must return one port to every caller
// and must never report exhaustion — that would be a lying error, since the
// range was never actually full.
func TestAllocatePortConcurrentSameTenantNeverErrors(t *testing.T) {
	const rounds, workers = 40, 8
	for r := 0; r < rounds; r++ {
		s := openTemp(t)
		var ready, done sync.WaitGroup
		start := make(chan struct{})
		ready.Add(workers)
		done.Add(workers)

		got := make([]int, workers)
		inserted := make([]bool, workers)
		errs := make([]error, workers)
		for i := 0; i < workers; i++ {
			go func(i int) {
				defer done.Done()
				ready.Done()
				<-start
				got[i], inserted[i], errs[i] = s.AllocatePort("same-tenant", 33100, 10)
			}(i)
		}
		ready.Wait()
		close(start)
		done.Wait()

		for i, err := range errs {
			if err != nil {
				t.Fatalf("round %d worker %d: same-tenant retry errored: %v", r, i, err)
			}
		}
		for i := 1; i < workers; i++ {
			if got[i] != got[0] {
				t.Fatalf("round %d: same tenant got two different ports: %d and %d", r, got[0], got[i])
			}
		}
		// Exactly one caller created the row. This is the whole exclusion the
		// provisioner relies on to refuse a duplicate Create: two callers both
		// told they created the tenant is two callers both entitled to unwind
		// it, and the loser's unwind destroys the winner's live instance.
		created := 0
		for _, ins := range inserted {
			if ins {
				created++
			}
		}
		if created != 1 {
			t.Fatalf("round %d: %d of %d concurrent same-tenant allocations reported inserted; exactly one may",
				r, created, workers)
		}
	}
}

// A tenant id can equal another tenant's already-sanitised instance name — the
// natural accident is pasting a mixed-case sub-account id and later retyping it
// in lower case. AllocatePort seeds the `instance` column, and INSERT OR IGNORE
// suppresses EVERY constraint violation, so seeding the raw id made that
// collision look exactly like "this port is taken" — for every port in the
// range, since the seeded value does not change between iterations. The loop
// then reported a full range that was almost entirely empty.
func TestAllocatePortWhenAnotherRowHoldsThisTenantsRawID(t *testing.T) {
	s := openTemp(t)
	if err := s.CreateTenant(Tenant{
		ID: "54vPI0BS", Instance: "54vpi0bs", Port: 33100, State: StateRunning,
	}); err != nil {
		t.Fatal(err)
	}
	// This tenant's OPAQUE id is the instance name the row above already holds.
	port, inserted, err := s.AllocatePort("54vpi0bs", 33100, 10)
	if err != nil {
		t.Fatalf("a duplicate tenant id must not look like an exhausted port range: %v", err)
	}
	if !inserted {
		t.Fatal("the allocation created the row and must report inserted")
	}
	if port != 33101 {
		t.Fatalf("want the lowest free port 33101, got %d", port)
	}
}

// The loop's remaining job: step over ports that really are taken, and still
// say so loudly when the range really is full.
func TestAllocatePortStepsOverTakenPortsAndStillReportsRealExhaustion(t *testing.T) {
	s := openTemp(t)
	for _, seed := range []struct {
		id, instance string
		port         int
	}{{"a", "inst-a", 33100}, {"b", "inst-b", 33102}} {
		if err := s.CreateTenant(Tenant{
			ID: seed.id, Instance: seed.instance, Port: seed.port, State: StateRunning,
		}); err != nil {
			t.Fatal(err)
		}
	}
	for _, want := range []int{33101, 33103} {
		got, _, err := s.AllocatePort("t"+string(rune('0'+want%10)), 33100, 4)
		if err != nil {
			t.Fatalf("want port %d, got error %v", want, err)
		}
		if got != want {
			t.Fatalf("want the lowest free port %d, got %d", want, got)
		}
	}
	// [33100,33104) now holds four rows.
	if _, _, err := s.AllocatePort("overflow", 33100, 4); err == nil {
		t.Fatal("a genuinely full range must still be a loud error")
	} else if !strings.Contains(err.Error(), "no free port") {
		t.Fatalf("exhaustion must still name itself: %v", err)
	}
}
