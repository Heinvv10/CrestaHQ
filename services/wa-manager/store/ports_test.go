package store

import (
	"sync"
	"testing"
)

func TestAllocatePortIsUniquePerTenant(t *testing.T) {
	s := openTemp(t)
	a, err := s.AllocatePort("t1", 33100, 10)
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.AllocatePort("t2", 33100, 10)
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatalf("two tenants got the same port: %d", a)
	}
}

func TestAllocatePortIsIdempotentForOneTenant(t *testing.T) {
	s := openTemp(t)
	a, _ := s.AllocatePort("t1", 33100, 10)
	b, err := s.AllocatePort("t1", 33100, 10)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatalf("re-allocating for one tenant moved its port %d -> %d", a, b)
	}
}

func TestAllocatePortExhaustionIsAnError(t *testing.T) {
	s := openTemp(t)
	for i := 0; i < 3; i++ {
		if _, err := s.AllocatePort(string(rune('a'+i)), 33100, 3); err != nil {
			t.Fatalf("allocation %d failed early: %v", i, err)
		}
	}
	if _, err := s.AllocatePort("overflow", 33100, 3); err == nil {
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
				got[i], errs[i] = s.AllocatePort(string(rune('a'+i)), 33100, workers)
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
		errs := make([]error, workers)
		for i := 0; i < workers; i++ {
			go func(i int) {
				defer done.Done()
				ready.Done()
				<-start
				got[i], errs[i] = s.AllocatePort("same-tenant", 33100, 10)
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
	}
}
